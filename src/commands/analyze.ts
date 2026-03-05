import chalk from 'chalk';
import ora from 'ora';
import { asc, eq, isNull } from 'drizzle-orm';
import { getDb, initDb } from '../db/index.js';
import { videos, videoSummaries, projectContext } from '../db/schema.js';
import { loadProjectConfig, resolveVideoFiles, getVideoFilename } from '../utils/project.js';
import { getVideoMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { statSync } from 'fs';
import { uploadVideoToGemini } from '../gemini/upload.js';
import { videoAnalysisPrompt, mergeFactsPrompt, projectOverviewPrompt } from '../prompts/index.js';
import { transcodeForUpload } from '../utils/transcode.js';
import { getModel, complete, type FileContent, type TextContent, type AssistantMessage, type Message } from '@mariozechner/pi-ai';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatCacheRate(usage: { input: number; cacheRead: number }): string | null {
  const total = usage.input + usage.cacheRead;
  if (total === 0 || usage.cacheRead === 0) return null;
  return `${Math.round((usage.cacheRead / total) * 100)}% cached`;
}

function assertComplete(result: AssistantMessage): void {
  if (result.stopReason === 'error') {
    throw new Error(result.errorMessage ?? 'LLM request failed');
  }
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function extractJson(text: string): string {
  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

class AsyncQueue<T> {
  private queue: T[] = [];
  private processing = false;
  private processor: (item: T) => Promise<void>;
  private resolveWhenDrained?: () => void;
  private itemCount = 0;
  private doneCount = 0;
  private sealed = false;

  constructor(processor: (item: T) => Promise<void>) {
    this.processor = processor;
  }

  enqueue(item: T): void {
    this.itemCount++;
    this.queue.push(item);
    void this.processNext();
  }

  seal(): void {
    this.sealed = true;
    this.checkDrained();
  }

  drain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveWhenDrained = resolve;
      this.checkDrained();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    try {
      await this.processor(item);
    } finally {
      this.doneCount++;
      this.processing = false;
      this.checkDrained();
      void this.processNext();
    }
  }

  private checkDrained(): void {
    if (
      this.sealed &&
      this.doneCount === this.itemCount &&
      this.queue.length === 0 &&
      !this.processing &&
      this.resolveWhenDrained
    ) {
      this.resolveWhenDrained();
    }
  }
}

function showVideoSummary(db: ReturnType<typeof getDb>, filename: string): void {
  const video = db
    .select()
    .from(videos)
    .where(eq(videos.filename, filename))
    .get();

  if (!video) {
    console.log(chalk.red(`Video "${filename}" not found.`));
    return;
  }

  const summary = db
    .select()
    .from(videoSummaries)
    .where(eq(videoSummaries.videoId, video.id))
    .get();

  if (!summary) {
    console.log(chalk.yellow(`Video "${filename}" has not been analyzed yet.`));
    return;
  }

  console.log(chalk.cyan(`\n${video.filename}`) + chalk.dim(` (ID: ${video.id}${video.durationSeconds ? `, ${video.durationSeconds}s` : ''})`));

  console.log(`\n${chalk.bold('Overview')}`);
  console.log(summary.overview);

  if (summary.location || summary.timeOfDay) {
    const parts = [summary.location, summary.timeOfDay].filter(Boolean);
    console.log(`\n${chalk.bold('Location / Time')}  ${parts.join(' · ')}`);
  }

  const segments = JSON.parse(summary.segments) as Array<Record<string, string>>;
  if (segments.length > 0) {
    console.log(`\n${chalk.bold('Segments')}`);
    for (const seg of segments) {
      console.log(chalk.green(`  ${seg.startTime}–${seg.endTime}`) + `  ${seg.description}`);
      if (seg.speechContent) {
        console.log(chalk.dim(`    Speech: `) + seg.speechContent);
      }
      if (seg.qualityNotes) {
        console.log(chalk.dim(`    Quality: `) + seg.qualityNotes);
      }
    }
  }

  const highlights = JSON.parse(summary.highlights) as Array<Record<string, string>>;
  if (highlights.length > 0) {
    console.log(`\n${chalk.bold('Highlights')}`);
    for (const hl of highlights) {
      console.log(chalk.green(`  ${hl.startTime}–${hl.endTime}`) + `  ${hl.reason}`);
    }
  }

  if (summary.technicalNotes) {
    console.log(`\n${chalk.bold('Technical Notes')}`);
    console.log(`  ${summary.technicalNotes}`);
  }

  console.log();
}

function formatDurationHuman(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function parseTimeToSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function listVideos(db: ReturnType<typeof getDb>): void {
  const allVideos = db.select().from(videos).orderBy(asc(videos.filename)).all();

  if (allVideos.length === 0) {
    console.log(chalk.yellow('No videos in database.'));
    return;
  }

  for (const video of allVideos) {
    const meta: string[] = [];
    if (video.width && video.height) meta.push(`${video.width}×${video.height}`);
    if (video.fpsNum && video.fpsDen) meta.push(`${(video.fpsNum / video.fpsDen).toFixed(2)}fps`);
    if (video.durationSeconds) meta.push(formatDurationHuman(video.durationSeconds));

    console.log(chalk.cyan(`${video.id}. ${video.filename}`) + (meta.length ? chalk.dim(` (${meta.join(', ')})`) : ''));

    const summary = db
      .select()
      .from(videoSummaries)
      .where(eq(videoSummaries.videoId, video.id))
      .get();

    if (!summary) {
      console.log(chalk.dim('   (not analyzed)\n'));
      continue;
    }

    const tags: string[] = [];

    if (summary.timeOfDay) tags.push(summary.timeOfDay);

    // Calculate highlights percentage
    if (video.durationSeconds) {
      const highlights = JSON.parse(summary.highlights) as Array<{ startTime: string; endTime: string }>;
      if (highlights.length > 0) {
        let highlightSeconds = 0;
        for (const hl of highlights) {
          highlightSeconds += parseTimeToSeconds(hl.endTime) - parseTimeToSeconds(hl.startTime);
        }
        const pct = Math.round((highlightSeconds / video.durationSeconds) * 100);
        tags.push(`highlights: ${pct}%`);
      }
    }

    if (tags.length > 0) {
      console.log(`   ${tags.join(chalk.dim(' | '))}`);
    }

    console.log(chalk.dim(`   ${summary.overview.replace(/\n/g, ' ')}`));
    console.log();
  }
}

export async function analyzeCommand(options: { reRun?: string; show?: string; list?: boolean; addFact?: string; project?: boolean }) {
  const config = loadProjectConfig();
  const db = await initDb();

  if (options.addFact) {
    const existing = db.select().from(projectContext).get();
    const prompt = mergeFactsPrompt(existing?.facts ?? null, options.addFact, config.intermediateLanguage);

    const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const spinner = ora('Merging fact...').start();

    const result = await complete(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
    }, { apiKey });
    assertComplete(result);
    const mergedFacts = getTextContent(result).trim();

    if (existing) {
      db.update(projectContext)
        .set({ facts: mergedFacts, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ facts: mergedFacts, updatedAt: new Date().toISOString() })
        .run();
    }

    // Invalidate generated overview when facts change
    if (existing) {
      db.update(projectContext)
        .set({ generatedOverviewStale: true })
        .where(eq(projectContext.id, existing.id))
        .run();
    }

    spinner.succeed('Fact added');
    console.log(chalk.dim(mergedFacts));
    return;
  }

  if (options.project) {
    const existing = db.select().from(projectContext).get();

    if (existing?.generatedOverview && !existing.generatedOverviewStale) {
      console.log(chalk.bold('Project Overview') + chalk.dim(' (cached)'));
      console.log(existing.generatedOverview);
      return;
    }

    // Gather all video summaries
    const allSummaries = db
      .select({
        videoId: videoSummaries.videoId,
        filename: videos.filename,
        overview: videoSummaries.overview,
        location: videoSummaries.location,
        timeOfDay: videoSummaries.timeOfDay,
      })
      .from(videoSummaries)
      .innerJoin(videos, eq(videoSummaries.videoId, videos.id))
      .orderBy(asc(videos.filename))
      .all();

    if (allSummaries.length === 0) {
      console.log(chalk.yellow('No video summaries yet. Run `montai analyze` first.'));
      return;
    }

    const prompt = projectOverviewPrompt(existing?.facts ?? null, allSummaries, config.intermediateLanguage);
    const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const spinner = ora('Generating project overview...').start();

    const result = await complete(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
    }, { apiKey });
    assertComplete(result);
    const overview = getTextContent(result).trim();

    if (existing) {
      db.update(projectContext)
        .set({ generatedOverview: overview, generatedOverviewStale: false, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ facts: '', generatedOverview: overview, generatedOverviewStale: false, updatedAt: new Date().toISOString() })
        .run();
    }

    spinner.succeed('Project overview generated');
    console.log(chalk.bold('Project Overview'));
    console.log(overview);
    return;
  }

  if (options.list) {
    listVideos(db);
    return;
  }

  if (options.show) {
    showVideoSummary(db, options.show);
    return;
  }

  const videoFiles = resolveVideoFiles(config);
  if (videoFiles.length === 0) {
    console.log(chalk.red('No video files found. Check your montai.yaml paths.'));
    return;
  }

  console.log(chalk.blue(`Found ${videoFiles.length} video file(s)`));

  // Sync discovered videos to database
  for (const filepath of videoFiles) {
    const filename = getVideoFilename(filepath);
    const existing = db
      .select()
      .from(videos)
      .where(eq(videos.path, filepath))
      .get();

    if (existing && (existing.width == null || existing.fpsNum == null || existing.totalFrames == null || existing.audioChannels == null || existing.startTimecode == null)) {
      const spinner = ora(`Updating metadata for ${filename}`).start();
      try {
        const meta = getVideoMetadata(filepath);
        db.update(videos)
          .set({
            width: meta.width, height: meta.height,
            fpsNum: meta.fpsNum, fpsDen: meta.fpsDen,
            totalFrames: meta.totalFrames,
            bitDepth: meta.bitDepth,
            colorSpace: meta.colorSpace,
            colorPrimaries: meta.colorPrimaries,
            colorTransfer: meta.colorTransfer,
            audioChannels: meta.audioChannels,
            audioSampleRate: meta.audioSampleRate,
            startTimecode: meta.startTimecode,
          })
          .where(eq(videos.id, existing.id))
          .run();
        spinner.succeed(`Updated ${filename} (${meta.width}x${meta.height}, ${(meta.fpsNum / meta.fpsDen).toFixed(2)}fps, ${meta.bitDepth ?? '?'}bit)`);
      } catch {
        spinner.warn(`Could not read metadata for ${filename}`);
      }
    } else if (!existing) {
      const spinner = ora(`Hashing ${filename}`).start();
      const md5 = await fileMd5(filepath);

      const md5Match = db
        .select()
        .from(videos)
        .where(eq(videos.md5, md5))
        .get();

      if (md5Match) {
        db.update(videos)
          .set({ path: filepath, filename })
          .where(eq(videos.id, md5Match.id))
          .run();
        spinner.succeed(`Re-linked ${filename} (was ${md5Match.filename})`);
      } else {
        try {
          const meta = getVideoMetadata(filepath);
          db.insert(videos)
            .values({
              filename, path: filepath, md5,
              durationSeconds: meta.durationSeconds,
              width: meta.width, height: meta.height,
              fpsNum: meta.fpsNum, fpsDen: meta.fpsDen,
              totalFrames: meta.totalFrames,
              bitDepth: meta.bitDepth,
              colorSpace: meta.colorSpace,
              colorPrimaries: meta.colorPrimaries,
              colorTransfer: meta.colorTransfer,
              audioChannels: meta.audioChannels,
              audioSampleRate: meta.audioSampleRate,
            })
            .run();
          spinner.succeed(`Registered ${filename} (${meta.width}x${meta.height}, ${(meta.fpsNum / meta.fpsDen).toFixed(2)}fps, ${meta.bitDepth ?? '?'}bit, ${meta.durationSeconds}s)`);
        } catch {
          db.insert(videos)
            .values({ filename, path: filepath, md5 })
            .run();
          spinner.warn(`Registered ${filename} (metadata unknown)`);
        }
      }
    }
  }

  // Get videos to analyze
  let videosToAnalyze;

  if (options.reRun) {
    videosToAnalyze = db
      .select()
      .from(videos)
      .where(eq(videos.filename, options.reRun))
      .all();
    if (videosToAnalyze.length === 0) {
      console.log(chalk.red(`Video "${options.reRun}" not found.`));
      return;
    }
  } else {
    // Left join video_summaries to find unanalyzed, ordered by filename for consistent shooting-order processing
    videosToAnalyze = db
      .select({ id: videos.id, filename: videos.filename, path: videos.path, md5: videos.md5, durationSeconds: videos.durationSeconds })
      .from(videos)
      .leftJoin(videoSummaries, eq(videos.id, videoSummaries.videoId))
      .where(isNull(videoSummaries.id))
      .orderBy(asc(videos.filename))
      .all();
  }

  if (videosToAnalyze.length === 0) {
    console.log(chalk.green('All videos already analyzed. Use --re-run <filename> to re-analyze.'));
    return;
  }

  console.log(chalk.blue(`Analyzing ${videosToAnalyze.length} video(s)...`));
  const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
  let totalCost = 0;
  let failed = 0;

  // Pipeline state tracking
  const pipelineState: { transcoding: string | null; uploading: string | null; analyzing: string | null } = {
    transcoding: null,
    uploading: null,
    analyzing: null,
  };
  const spinner = ora();

  function updateSpinner(): void {
    const parts: string[] = [];
    if (pipelineState.transcoding) parts.push(`Transcoding: ${pipelineState.transcoding}`);
    if (pipelineState.uploading) parts.push(`Uploading: ${pipelineState.uploading}`);
    if (pipelineState.analyzing) parts.push(`Analyzing: ${pipelineState.analyzing}`);
    if (parts.length > 0) {
      spinner.text = parts.join(chalk.dim(' | '));
      if (!spinner.isSpinning) spinner.start();
    } else if (spinner.isSpinning) {
      spinner.stop();
    }
  }

  function logLine(message: string): void {
    if (spinner.isSpinning) {
      spinner.clear();
    }
    console.log(message);
    if (spinner.isSpinning) {
      spinner.render();
    }
  }

  type VideoItem = typeof videosToAnalyze[number];

  // Stage 3: Analyze (defined first since Stage 2 references it)
  const analyzeQueue = new AsyncQueue<{ video: VideoItem; fileUri: string }>(async ({ video, fileUri }) => {
    pipelineState.analyzing = video.filename;
    updateSpinner();

    try {
      const fileContent: FileContent = {
        type: 'file',
        uri: fileUri,
        mimeType: 'video/mp4',
      };

      const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const currentContext = db.select().from(projectContext).get();
      const analysisPrompt = videoAnalysisPrompt(config.intermediateLanguage, currentContext?.facts);

      const messages: Message[] = [
        {
          role: 'user',
          content: [fileContent, { type: 'text', text: analysisPrompt }],
          timestamp: Date.now(),
        },
      ];

      // Video analysis
      const t0 = Date.now();
      const analysisResult = await complete(model, { messages }, { apiKey });
      assertComplete(analysisResult);
      const analysisText = getTextContent(analysisResult);
      totalCost += analysisResult.usage.cost.total;
      const analysisCacheRate = formatCacheRate(analysisResult.usage);
      logLine(chalk.green(`  ✓ Analyzed ${video.filename} (${formatDuration(Date.now() - t0)}, ${formatCost(analysisResult.usage.cost.total)}, ${config.models.analysis}${analysisCacheRate ? `, ${analysisCacheRate}` : ''})`));

      // Parse and store video summary
      let parsedAnalysis: Record<string, unknown>;
      try {
        parsedAnalysis = JSON.parse(extractJson(analysisText));
      } catch {
        logLine(chalk.yellow(`  Warning: Could not parse analysis JSON for ${video.filename}, storing raw text`));
        parsedAnalysis = { overview: analysisText };
      }

      const summaryFields = {
        overview: String(parsedAnalysis.overview ?? ''),
        location: parsedAnalysis.location ? String(parsedAnalysis.location) : null,
        timeOfDay: parsedAnalysis.timeOfDay ? String(parsedAnalysis.timeOfDay) : null,
        segments: JSON.stringify(parsedAnalysis.segments ?? []),
        highlights: JSON.stringify(parsedAnalysis.highlights ?? []),
        technicalNotes: parsedAnalysis.technicalNotes ? String(parsedAnalysis.technicalNotes) : null,
      };

      const existingSummary = db
        .select()
        .from(videoSummaries)
        .where(eq(videoSummaries.videoId, video.id))
        .get();

      if (existingSummary) {
        db.update(videoSummaries)
          .set(summaryFields)
          .where(eq(videoSummaries.videoId, video.id))
          .run();
      } else {
        db.insert(videoSummaries)
          .values({ videoId: video.id, ...summaryFields })
          .run();
      }

      // Invalidate generated overview when video summaries change
      const currentCtx = db.select().from(projectContext).get();
      if (currentCtx) {
        db.update(projectContext)
          .set({ generatedOverviewStale: true })
          .where(eq(projectContext.id, currentCtx.id))
          .run();
      }

    } catch (err) {
      logLine(chalk.red(`  ✗ Failed to analyze ${video.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.analyzing = null;
      updateSpinner();
    }
  });

  // Stage 2: Upload
  const uploadQueue = new AsyncQueue<{ video: VideoItem; transcodedPath: string }>(async ({ video, transcodedPath }) => {
    pipelineState.uploading = video.filename;
    updateSpinner();

    try {
      const t0 = Date.now();
      const fileUri = await uploadVideoToGemini(video.id, transcodedPath);
      logLine(chalk.green(`  ✓ Uploaded ${video.filename} (${formatDuration(Date.now() - t0)})`));
      analyzeQueue.enqueue({ video, fileUri });
    } catch (err) {
      logLine(chalk.red(`  ✗ Failed to upload ${video.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.uploading = null;
      updateSpinner();
    }
  });

  // Stage 1: Transcode
  const transcodeQueue = new AsyncQueue<{ video: VideoItem }>(async ({ video }) => {
    pipelineState.transcoding = video.filename;
    updateSpinner();

    try {
      const t0 = Date.now();
      const transcoded = await transcodeForUpload(video.id, video.path);
      const transcodedSize = formatFileSize(statSync(transcoded.path).size);
      if (transcoded.cached) {
        logLine(chalk.green(`  ✓ Transcoded ${video.filename} (cached, ${transcodedSize})`));
      } else {
        logLine(chalk.green(`  ✓ Transcoded ${video.filename} (${formatDuration(Date.now() - t0)}, ${transcodedSize})`));
      }
      uploadQueue.enqueue({ video, transcodedPath: transcoded.path });
    } catch (err) {
      logLine(chalk.red(`  ✗ Failed to transcode ${video.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.transcoding = null;
      updateSpinner();
    }
  });

  // Start the pipeline: enqueue all videos to transcode stage
  for (const video of videosToAnalyze) {
    transcodeQueue.enqueue({ video });
  }
  transcodeQueue.seal();

  // Chain stage sealing: when one stage drains, seal the next
  transcodeQueue.drain().then(() => uploadQueue.seal());
  uploadQueue.drain().then(() => analyzeQueue.seal());

  await analyzeQueue.drain();
  spinner.stop();

  if (failed > 0) {
    console.log(chalk.yellow(`\nAnalysis complete with ${failed} failure(s), total cost: ${formatCost(totalCost)}. Re-run to retry failed videos.`));
  } else {
    console.log(chalk.green(`\nAnalysis complete! Total cost: ${formatCost(totalCost)}`));
  }
}
