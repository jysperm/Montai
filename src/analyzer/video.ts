import chalk from 'chalk';
import ora from 'ora';
import { asc, eq, isNull } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { videos, videoAnalyses, projectContext } from '../db/schema.js';
import { resolveVideoFiles, getVideoFilename, readProjectFile } from '../utils/project.js';
import { getVideoMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { statSync } from 'fs';
import { resolve, basename } from 'path';
import { uploadVideoToGemini } from '../gemini/upload.js';
import { renderPrompt } from '../prompts/index.js';
import { transcodeForUpload } from '../utils/transcode.js';
import { complete, type FileContent, type Message } from '@mariozechner/pi-ai';
import type { ProjectConfig } from '../schemas/project.js';
import { AsyncQueue, assertComplete, getTextContent, extractJson, formatDuration, formatCost } from './utils.js';
import { completeWithLogging } from '../utils/llm-logging.js';
import { formatDuration as formatDurationHuman, formatFileSize } from '../utils/format.js';

function formatCacheRate(usage: { input: number; cacheRead: number }): string | null {
  const total = usage.input + usage.cacheRead;
  if (total === 0 || usage.cacheRead === 0) return null;
  return `${Math.round((usage.cacheRead / total) * 100)}% cached`;
}

function parseTimeToSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

export function showVideoAnalysis(db: MontaiDb, filename: string): void {
  // First try matching by filename (basename)
  let video = db
    .select()
    .from(videos)
    .where(eq(videos.filename, basename(filename)))
    .get();
  // If no match, try resolving as a path
  if (!video) {
    const resolvedPath = resolve(filename);
    video = db
      .select()
      .from(videos)
      .where(eq(videos.path, resolvedPath))
      .get();
  }

  if (!video) {
    console.log(chalk.red(`Video "${filename}" not found.`));
    return;
  }

  const analysis = db
    .select()
    .from(videoAnalyses)
    .where(eq(videoAnalyses.videoId, video.id))
    .get();

  if (!analysis) {
    console.log(chalk.yellow(`Video "${filename}" has not been analyzed yet.`));
    return;
  }

  console.log(chalk.cyan(`\n${video.filename}`) + chalk.dim(` (ID: ${video.id}${video.durationSeconds ? `, ${video.durationSeconds}s` : ''})`));

  console.log(`\n${chalk.bold('Overview')}`);
  console.log(analysis.overview);

  if (analysis.location || analysis.timeOfDay) {
    const parts = [analysis.location, analysis.timeOfDay].filter(Boolean);
    console.log(`\n${chalk.bold('Location / Time')}  ${parts.join(' · ')}`);
  }

  const segments = JSON.parse(analysis.segments) as Array<Record<string, string>>;
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

  const highlights = JSON.parse(analysis.highlights) as Array<Record<string, string>>;
  if (highlights.length > 0) {
    console.log(`\n${chalk.bold('Highlights')}`);
    for (const hl of highlights) {
      console.log(chalk.green(`  ${hl.startTime}–${hl.endTime}`) + `  ${hl.reason}`);
    }
  }

  if (analysis.technicalNotes) {
    console.log(`\n${chalk.bold('Technical Notes')}`);
    console.log(`  ${analysis.technicalNotes}`);
  }

  console.log();
}

export function listVideos(db: MontaiDb): void {
  const allVideos = db.select().from(videos).orderBy(asc(videos.filename)).all();

  if (allVideos.length === 0) {
    console.log(chalk.dim('No videos in database.'));
    return;
  }

  for (const video of allVideos) {
    const meta: string[] = [];
    if (video.width && video.height) meta.push(`${video.width}×${video.height}`);
    if (video.fpsNum && video.fpsDen) meta.push(`${(video.fpsNum / video.fpsDen).toFixed(2)}fps`);
    if (video.durationSeconds) meta.push(formatDurationHuman(video.durationSeconds));

    console.log(chalk.cyan(`${video.id}. ${video.filename}`) + (meta.length ? chalk.dim(` (${meta.join(', ')})`) : ''));

    const analysis = db
      .select()
      .from(videoAnalyses)
      .where(eq(videoAnalyses.videoId, video.id))
      .get();

    if (!analysis) {
      console.log(chalk.dim('   (not analyzed)\n'));
      continue;
    }

    const tags: string[] = [];

    if (analysis.timeOfDay) tags.push(analysis.timeOfDay);

    if (video.durationSeconds) {
      const highlights = JSON.parse(analysis.highlights) as Array<{ startTime: string; endTime: string }>;
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

    console.log(chalk.dim(`   ${analysis.overview.replace(/\n/g, ' ')}`));
    console.log();
  }
}

export async function syncAndAnalyzeVideos(
  db: MontaiDb,
  config: ProjectConfig,
  model: Parameters<typeof complete>[0],
  options?: { reRun?: string },
): Promise<{ totalCost: number }> {
  const videoFiles = resolveVideoFiles(config);
  if (videoFiles.length === 0) {
    console.log(chalk.red('No videos found. Check your montai.yaml paths.'));
    return { totalCost: 0 };
  }

  console.log(chalk.blue(`Found ${videoFiles.length} video(s)`));

  // Sync discovered videos to database
  for (const filepath of videoFiles) {
    const filename = getVideoFilename(filepath);
    const existing = db
      .select()
      .from(videos)
      .where(eq(videos.path, filepath))
      .get();

    if (existing && (existing.durationSeconds == null || existing.width == null || existing.fpsNum == null || existing.fps == null || existing.totalFrames == null || existing.audioChannels == null || existing.startTimecode == null)) {
      const spinner = ora(`Updating metadata for ${filename}`).start();
      try {
        const meta = getVideoMetadata(filepath);
        db.update(videos)
          .set({
            durationSeconds: meta.durationSeconds,
            width: meta.width, height: meta.height,
            fpsNum: meta.fpsNum, fpsDen: meta.fpsDen,
            totalFrames: meta.totalFrames,
            fps: String(meta.fps),
            bitDepth: meta.bitDepth,
            colorPrimaries: meta.colorPrimaries,
            colorTransfer: meta.colorTransfer,
            audioChannels: meta.audioChannels,
            audioSampleRate: meta.audioSampleRate,
            startTimecode: meta.startTimecode,
          })
          .where(eq(videos.id, existing.id))
          .run();
        spinner.succeed(`Updated ${filename} (${meta.width}x${meta.height}, ${meta.fps}fps, ${meta.bitDepth ?? '?'}bit)`);
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
              fps: String(meta.fps),
              bitDepth: meta.bitDepth,
              colorPrimaries: meta.colorPrimaries,
              colorTransfer: meta.colorTransfer,
              audioChannels: meta.audioChannels,
              audioSampleRate: meta.audioSampleRate,
              startTimecode: meta.startTimecode,
            })
            .run();
          spinner.succeed(`Registered ${filename} (${meta.width}x${meta.height}, ${meta.fps}fps, ${meta.bitDepth ?? '?'}bit, ${meta.durationSeconds}s)`);
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

  if (options?.reRun) {
    // First try matching by filename (basename)
    videosToAnalyze = db
      .select()
      .from(videos)
      .where(eq(videos.filename, basename(options.reRun)))
      .all();
    // If no match, try resolving as a path
    if (videosToAnalyze.length === 0) {
      const resolvedPath = resolve(options.reRun);
      videosToAnalyze = db
        .select()
        .from(videos)
        .where(eq(videos.path, resolvedPath))
        .all();
    }
    if (videosToAnalyze.length === 0) {
      console.log(chalk.red(`Video "${options.reRun}" not found.`));
      return { totalCost: 0 };
    }
  } else {
    videosToAnalyze = db
      .select({ id: videos.id, filename: videos.filename, path: videos.path, md5: videos.md5, durationSeconds: videos.durationSeconds })
      .from(videos)
      .leftJoin(videoAnalyses, eq(videos.id, videoAnalyses.videoId))
      .where(isNull(videoAnalyses.id))
      .orderBy(asc(videos.filename))
      .all();
  }

  if (videosToAnalyze.length === 0) {
    console.log(chalk.green(`All videos already analyzed. Use ${chalk.bold('--re-run <filename>')} to re-analyze.`));
    return { totalCost: 0 };
  }

  const agentInstructions = readProjectFile('AGENTS.md');

  console.log(chalk.blue(`Analyzing ${videosToAnalyze.length} video(s)...`));
  let totalCost = 0;
  let failed = 0;

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
      const analysisPrompt = renderPrompt('analyze-video', { language: config.language, facts: currentContext?.facts ?? null, agentInstructions: agentInstructions ?? null });

      const messages: Message[] = [
        {
          role: 'user',
          content: [fileContent, { type: 'text', text: analysisPrompt }],
          timestamp: Date.now(),
        },
      ];

      const t0 = Date.now();
      const analysisResult = await completeWithLogging(model, { messages }, { apiKey });
      assertComplete(analysisResult);
      const analysisText = getTextContent(analysisResult);
      totalCost += analysisResult.usage.cost.total;
      const analysisCacheRate = formatCacheRate(analysisResult.usage);
      logLine(chalk.green(`  ✓ Analyzed ${video.filename} (${formatDuration(Date.now() - t0)}, ${formatCost(analysisResult.usage.cost.total)}, ${config.models.analysis}${analysisCacheRate ? `, ${analysisCacheRate}` : ''})`));

      let parsedAnalysis: Record<string, unknown>;
      try {
        parsedAnalysis = JSON.parse(extractJson(analysisText));
      } catch {
        logLine(chalk.yellow(`  Warning: Could not parse analysis JSON for ${video.filename}, storing raw text`));
        parsedAnalysis = { overview: analysisText };
      }

      const analysisFields = {
        overview: String(parsedAnalysis.overview ?? ''),
        location: parsedAnalysis.location ? String(parsedAnalysis.location) : null,
        timeOfDay: parsedAnalysis.timeOfDay ? String(parsedAnalysis.timeOfDay) : null,
        segments: JSON.stringify(parsedAnalysis.segments ?? []),
        highlights: JSON.stringify(parsedAnalysis.highlights ?? []),
        technicalNotes: parsedAnalysis.technicalNotes ? String(parsedAnalysis.technicalNotes) : null,
      };

      const existingAnalysis = db
        .select()
        .from(videoAnalyses)
        .where(eq(videoAnalyses.videoId, video.id))
        .get();

      if (existingAnalysis) {
        db.update(videoAnalyses)
          .set(analysisFields)
          .where(eq(videoAnalyses.videoId, video.id))
          .run();
      } else {
        db.insert(videoAnalyses)
          .values({ videoId: video.id, ...analysisFields })
          .run();
      }

      const currentCtx = db.select().from(projectContext).get();
      if (currentCtx) {
        db.update(projectContext)
          .set({ overviewStale: true })
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

  for (const video of videosToAnalyze) {
    transcodeQueue.enqueue({ video });
  }
  transcodeQueue.seal();

  transcodeQueue.drain().then(() => uploadQueue.seal());
  uploadQueue.drain().then(() => analyzeQueue.seal());

  await analyzeQueue.drain();
  spinner.stop();

  if (failed > 0) {
    console.log(chalk.yellow(`\nVideo analysis complete with ${failed} failure(s), total cost: ${formatCost(totalCost)}. Re-run to retry failed videos.`));
  } else {
    console.log(chalk.green(`\nVideo analysis complete! Total cost: ${formatCost(totalCost)}`));
  }

  return { totalCost };
}
