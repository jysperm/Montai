import chalk from 'chalk';
import ora from 'ora';
import { eq } from 'drizzle-orm';
import { statSync } from 'fs';
import { cpus } from 'os';
import { extname } from 'path';
import type { ZodType } from 'zod';
import type { MontaiDb } from '../db/index.js';
import { videoAnalyses, musicAnalyses, voiceoverAnalyses, projectContext } from '../db/schema.js';
import { uploadFileToGemini } from '../gemini/upload.js';
import { transcodeForUpload } from '../utils/transcode.js';
import { analysisSignature, provenanceFor, renderAnalysisPrompt, type AnalysisProvenance } from './provenance.js';
import { formatFileSize } from '../utils/format.js';
import { type completeSimple, type FileContent, type Message } from '@mariozechner/pi-ai';
import type { ProjectConfig } from '../schemas/project.js';
import { AsyncQueue, completeWithSchemaRetry, formatDuration, formatCost } from './utils.js';
import { VideoAnalysisSchema, MusicAnalysisSchema, VoiceoverAnalysisSchema } from '../schemas/analysis.js';

export type AnalyzeKind = 'video' | 'music' | 'voiceover';

export interface AnalyzeItem {
  kind: AnalyzeKind;
  id: number;
  filename: string;
  path: string;
}

// Per-stage concurrency. Each defaults independently and is overridable via featureFlags.
// transcode is decode-bound, so it scales with cores (CPU/4, min 2); upload/analyze are network-bound and default to 2.
function resolveConcurrency(config: ProjectConfig): { transcode: number; upload: number; analyze: number } {
  const flags = config.featureFlags;
  return {
    transcode: flags.transcodeConcurrency ?? Math.max(2, Math.floor(cpus().length / 4)),
    upload: flags.uploadConcurrency ?? 2,
    analyze: flags.analyzeConcurrency ?? 2,
  };
}

const audioMimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

function audioMimeType(item: AnalyzeItem): string {
  return audioMimeTypes[extname(item.path).toLowerCase()] ?? 'audio/mpeg';
}

function formatCacheRate(usage: { input: number; cacheRead: number }): string | null {
  const total = usage.input + usage.cacheRead;
  if (total === 0 || usage.cacheRead === 0) return null;
  return `${Math.round((usage.cacheRead / total) * 100)}% cached`;
}

interface KindHandler {
  needsTranscode: boolean;
  mimeType: (item: AnalyzeItem) => string;
  promptName: string;
  schema: ZodType;
  persist: (db: MontaiDb, item: AnalyzeItem, parsed: Record<string, unknown>, provenance: AnalysisProvenance) => void;
}

const handlers: Record<AnalyzeKind, KindHandler> = {
  video: {
    needsTranscode: true,
    mimeType: () => 'video/mp4',
    promptName: 'analyze-video',
    schema: VideoAnalysisSchema,
    persist: (db, item, parsed, provenance) => {
      const fields = {
        overview: String(parsed.overview ?? ''),
        location: parsed.location ? String(parsed.location) : null,
        timeOfDay: parsed.timeOfDay ? String(parsed.timeOfDay) : null,
        segments: JSON.stringify(parsed.segments ?? []),
        highlights: JSON.stringify(parsed.highlights ?? []),
        technicalNotes: parsed.technicalNotes ? String(parsed.technicalNotes) : null,
        ...provenance,
      };
      const existing = db.select().from(videoAnalyses).where(eq(videoAnalyses.videoId, item.id)).get();
      if (existing) {
        db.update(videoAnalyses).set(fields).where(eq(videoAnalyses.videoId, item.id)).run();
      } else {
        db.insert(videoAnalyses).values({ videoId: item.id, ...fields }).run();
      }
      const ctx = db.select().from(projectContext).get();
      if (ctx) {
        db.update(projectContext).set({ overviewStale: true }).where(eq(projectContext.id, ctx.id)).run();
      }
    },
  },
  music: {
    needsTranscode: false,
    mimeType: audioMimeType,
    promptName: 'analyze-music',
    schema: MusicAnalysisSchema,
    persist: (db, item, parsed, provenance) => {
      db.insert(musicAnalyses).values({
        musicId: item.id,
        overview: String(parsed.overview ?? ''),
        segments: JSON.stringify(parsed.segments ?? []),
        ...provenance,
      }).run();
    },
  },
  voiceover: {
    needsTranscode: false,
    mimeType: audioMimeType,
    promptName: 'analyze-voiceover',
    schema: VoiceoverAnalysisSchema,
    persist: (db, item, parsed, provenance) => {
      db.insert(voiceoverAnalyses).values({
        voiceoverId: item.id,
        overview: String(parsed.overview ?? ''),
        transcription: JSON.stringify(parsed.transcription ?? []),
        ...provenance,
      }).run();
    },
  },
};

// Runs all media types through one shared 3-stage pipeline (transcode → upload → analyze).
// Audio (music/voiceover) skips transcode and is enqueued straight to upload.
export async function runAnalysisPipeline(
  db: MontaiDb,
  config: ProjectConfig,
  model: Parameters<typeof completeSimple>[0],
  items: AnalyzeItem[],
): Promise<{ totalCost: number }> {
  if (items.length === 0) return { totalCost: 0 };

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const concurrency = resolveConcurrency(config);

  console.log(chalk.blue(`Analyzing ${items.length} assets...`));
  let totalCost = 0;
  let failed = 0;

  const pipelineState = {
    transcoding: new Set<string>(),
    uploading: new Set<string>(),
    analyzing: new Set<string>(),
  };
  const spinner = ora();

  function updateSpinner(): void {
    const parts: string[] = [];
    if (pipelineState.transcoding.size) parts.push(`Transcoding: ${[...pipelineState.transcoding].join(', ')}`);
    if (pipelineState.uploading.size) parts.push(`Uploading: ${[...pipelineState.uploading].join(', ')}`);
    if (pipelineState.analyzing.size) parts.push(`Analyzing: ${[...pipelineState.analyzing].join(', ')}`);
    if (parts.length > 0) {
      spinner.text = parts.join(chalk.dim(' | '));
      if (!spinner.isSpinning) spinner.start();
    } else if (spinner.isSpinning) {
      spinner.stop();
    }
  }

  function logLine(message: string): void {
    if (spinner.isSpinning) spinner.clear();
    console.log(message);
    if (spinner.isSpinning) spinner.render();
  }

  const analyzeQueue = new AsyncQueue<{ item: AnalyzeItem; fileUri: string }>(async ({ item, fileUri }) => {
    const handler = handlers[item.kind];
    pipelineState.analyzing.add(item.filename);
    updateSpinner();

    try {
      const fileContent: FileContent = { type: 'file', uri: fileUri, mimeType: handler.mimeType(item) };
      const prompt = renderAnalysisPrompt(config, item.kind);
      const messages: Message[] = [
        { role: 'user', content: [fileContent, { type: 'text', text: prompt }], timestamp: Date.now() },
      ];

      const t0 = Date.now();
      const retryResult = await completeWithSchemaRetry({
        model,
        messages,
        apiKey,
        schema: handler.schema,
        maxRetries: 2,
        onAttempt: ({ attempt, error, isFinal }) => {
          if (error && !isFinal) logLine(chalk.yellow(`Retry ${attempt + 1} for ${item.filename}: ${error}`));
        },
      });
      totalCost += retryResult.totalCost;
      if (retryResult.finalError) {
        throw new Error(`schema validation failed after ${retryResult.attempts} attempts: ${retryResult.finalError}`);
      }

      handler.persist(db, item, retryResult.raw, provenanceFor(analysisSignature(config, item.kind, model.id)));

      const cacheRate = formatCacheRate(retryResult.lastResult.usage);
      const attemptsTag = retryResult.attempts > 1 ? `, ${retryResult.attempts} attempts` : '';
      logLine(chalk.green(`✓ Analyzed ${item.filename} (${formatDuration(Date.now() - t0)}, ${config.models.analysis}, ${formatCost(retryResult.totalCost)}${cacheRate ? `, ${cacheRate}` : ''}${attemptsTag})`));
    } catch (err) {
      logLine(chalk.red(`✗ Failed to analyze ${item.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.analyzing.delete(item.filename);
      updateSpinner();
    }
  }, concurrency.analyze);

  const uploadQueue = new AsyncQueue<{ item: AnalyzeItem; uploadPath: string }>(async ({ item, uploadPath }) => {
    pipelineState.uploading.add(item.filename);
    updateSpinner();

    try {
      const t0 = Date.now();
      const uploaded = await uploadFileToGemini(uploadPath);
      logLine(uploaded.cached
        ? chalk.green(`✓ Uploaded ${item.filename} (cached)`)
        : chalk.green(`✓ Uploaded ${item.filename} (${formatDuration(Date.now() - t0)})`));
      analyzeQueue.enqueue({ item, fileUri: uploaded.fileUri });
    } catch (err) {
      logLine(chalk.red(`✗ Failed to upload ${item.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.uploading.delete(item.filename);
      updateSpinner();
    }
  }, concurrency.upload);

  const transcodeQueue = new AsyncQueue<{ item: AnalyzeItem }>(async ({ item }) => {
    pipelineState.transcoding.add(item.filename);
    updateSpinner();

    try {
      const t0 = Date.now();
      const transcoded = await transcodeForUpload(item.id, item.path, config.featureFlags.transcodeFps);
      const size = formatFileSize(statSync(transcoded.path).size);
      const hwTag = transcoded.hwaccel ? `${transcoded.hwaccel}, ` : '';
      logLine(transcoded.cached
        ? chalk.green(`✓ Transcoded ${item.filename} (cached, ${size})`)
        : chalk.green(`✓ Transcoded ${item.filename} (${hwTag}${formatDuration(Date.now() - t0)}, ${size})`));
      uploadQueue.enqueue({ item, uploadPath: transcoded.path });
    } catch (err) {
      logLine(chalk.red(`✗ Failed to transcode ${item.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.transcoding.delete(item.filename);
      updateSpinner();
    }
  }, concurrency.transcode);

  for (const item of items) {
    if (handlers[item.kind].needsTranscode) {
      transcodeQueue.enqueue({ item });
    } else {
      uploadQueue.enqueue({ item, uploadPath: item.path });
    }
  }
  transcodeQueue.seal();

  transcodeQueue.drain().then(() => uploadQueue.seal());
  uploadQueue.drain().then(() => analyzeQueue.seal());

  await analyzeQueue.drain();
  spinner.stop();

  if (failed > 0) {
    console.log(chalk.yellow(`\nAnalysis complete with ${failed} failures. Re-run to retry failures.`));
  } else {
    console.log(chalk.green(`\nAnalysis complete!`));
  }

  return { totalCost };
}
