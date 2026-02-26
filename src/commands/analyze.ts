import chalk from 'chalk';
import ora from 'ora';
import { eq, isNull } from 'drizzle-orm';
import { getDb, initDb } from '../db/index.js';
import { videos, videoSummaries, projectSummary } from '../db/schema.js';
import { loadProjectConfig, resolveVideoFiles, getVideoFilename } from '../utils/project.js';
import { getVideoMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { statSync } from 'fs';
import { uploadVideoToGemini } from '../gemini/upload.js';
import { videoAnalysisPrompt, projectSummaryPrompt } from '../prompts/index.js';
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

export async function analyzeCommand(options: { reRun?: string; show?: string }) {
  const config = loadProjectConfig();
  const db = await initDb();

  if (options.show) {
    showVideoSummary(db, options.show);
    return;
  }

  const videoFiles = resolveVideoFiles(config);
  if (videoFiles.length === 0) {
    console.log(chalk.red('No video files found. Check your cutflow.yaml paths.'));
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
    // Left join video_summaries to find unanalyzed
    videosToAnalyze = db
      .select({ id: videos.id, filename: videos.filename, path: videos.path, md5: videos.md5, durationSeconds: videos.durationSeconds })
      .from(videos)
      .leftJoin(videoSummaries, eq(videos.id, videoSummaries.videoId))
      .where(isNull(videoSummaries.id))
      .all();
  }

  if (videosToAnalyze.length === 0) {
    console.log(chalk.green('All videos already analyzed. Use --re-run <filename> to re-analyze.'));
    return;
  }

  console.log(chalk.blue(`Analyzing ${videosToAnalyze.length} video(s)...`));
  const model = getModel('google', config.models.analyze as Parameters<typeof getModel>[1]);
  let totalCost = 0;
  let failed = 0;

  for (const video of videosToAnalyze) {
    console.log(chalk.cyan(`\n--- ${video.filename} (ID: ${video.id}) ---`));

    let spinner = ora();

    try {
      // Step 1: Transcode for upload
      spinner = ora('Transcoding video...').start();
      let t0 = Date.now();
      const transcoded = await transcodeForUpload(video.id, video.path);
      const transcodedSize = formatFileSize(statSync(transcoded.path).size);
      if (transcoded.cached) {
        spinner.succeed(`Transcoded (${transcodedSize}, cached)`);
      } else {
        spinner.succeed(`Transcoded (${transcodedSize}, ${formatDuration(Date.now() - t0)})`);
      }

      // Step 2: Upload to Gemini
      spinner = ora('Uploading to Gemini...').start();
      t0 = Date.now();
      const fileUri = await uploadVideoToGemini(video.id, transcoded.path);
      spinner.succeed(`Uploaded to Gemini (${formatDuration(Date.now() - t0)})`);

      const fileContent: FileContent = {
        type: 'file',
        uri: fileUri,
        mimeType: 'video/mp4',
      };

      // Build conversation messages incrementally across steps
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const currentProjectSummary = db.select().from(projectSummary).get();
      const analysisPrompt = videoAnalysisPrompt(config.intermediateLanguage, currentProjectSummary?.content);

      const messages: Message[] = [
        {
          role: 'user',
          content: [fileContent, { type: 'text', text: analysisPrompt }],
          timestamp: Date.now(),
        },
      ];

      // Step 3: Analyze video
      spinner = ora('Analyzing video content...').start();
      t0 = Date.now();
      const analysisResult = await complete(model, { messages }, { apiKey });

      assertComplete(analysisResult);
      const analysisText = getTextContent(analysisResult);
      totalCost += analysisResult.usage.cost.total;
      const analysisCacheRate = formatCacheRate(analysisResult.usage);
      spinner.succeed(`Video analysis complete (${formatDuration(Date.now() - t0)}, ${formatCost(analysisResult.usage.cost.total)}, ${config.models.analyze}${analysisCacheRate ? `, ${analysisCacheRate}` : ''})`);

      // Append assistant response to conversation (text only, drop tool calls etc.)
      messages.push({ ...analysisResult, content: [{ type: 'text', text: analysisText }] });

      // Step 4: Parse and store video summary
      let parsedAnalysis: Record<string, unknown>;
      try {
        parsedAnalysis = JSON.parse(extractJson(analysisText));
      } catch {
        console.log(chalk.yellow('Warning: Could not parse analysis JSON, storing raw text'));
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

      // Step 5: Update project summary (multi-turn, extending the conversation)
      spinner = ora('Updating project summary...').start();
      t0 = Date.now();
      const latestProjectSummary = db.select().from(projectSummary).get();
      const summaryPromptText = projectSummaryPrompt(
        latestProjectSummary?.content ?? null,
        video.id,
        config.intermediateLanguage
      );

      messages.push({
        role: 'user',
        content: [{ type: 'text', text: summaryPromptText }],
        timestamp: Date.now(),
      });

      const summaryResult = await complete(model, { messages }, { apiKey });

      assertComplete(summaryResult);
      const updatedSummaryText = getTextContent(summaryResult);
      totalCost += summaryResult.usage.cost.total;

      if (latestProjectSummary) {
        db.update(projectSummary)
          .set({
            content: updatedSummaryText,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(projectSummary.id, latestProjectSummary.id))
          .run();
      } else {
        db.insert(projectSummary)
          .values({
            content: updatedSummaryText,
            updatedAt: new Date().toISOString(),
          })
          .run();
      }

      const summaryCacheRate = formatCacheRate(summaryResult.usage);
      spinner.succeed(`Project summary updated (${formatDuration(Date.now() - t0)}, ${formatCost(summaryResult.usage.cost.total)}, ${config.models.analyze}${summaryCacheRate ? `, ${summaryCacheRate}` : ''})`);

      console.log(chalk.green(`Completed analysis for ${video.filename}`));
    } catch (err) {
      spinner.fail(`Failed to analyze ${video.filename}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.log(chalk.yellow(`\nAnalysis complete with ${failed} failure(s), total cost: ${formatCost(totalCost)}. Re-run to retry failed videos.`));
  } else {
    console.log(chalk.green(`\nAnalysis complete! Total cost: ${formatCost(totalCost)}`));
  }
}
