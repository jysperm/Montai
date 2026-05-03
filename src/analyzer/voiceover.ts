import chalk from 'chalk';
import ora from 'ora';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { voiceovers, voiceoverAnalyses } from '../db/schema.js';
import { resolveVoiceoverFiles, getVoiceoverFilename, readProjectFile } from '../utils/project.js';
import { getAudioMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { extname, resolve, basename } from 'path';
import { uploadFileToGemini } from '../gemini/upload.js';
import { renderPrompt } from '../prompts/index.js';
import { complete, type FileContent, type Message } from '@mariozechner/pi-ai';
import type { ProjectConfig } from '../schemas/project.js';
import { AsyncQueue, assertComplete, getTextContent, extractJson, formatDuration, formatCost } from './utils.js';
import { completeWithLogging } from '../utils/llm-logging.js';

const mimeTypeMap: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

export function showVoiceoverAnalysis(db: MontaiDb, filename: string): void {
  let track = db
    .select()
    .from(voiceovers)
    .where(eq(voiceovers.filename, basename(filename)))
    .get();
  if (!track) {
    const resolvedPath = resolve(filename);
    track = db
      .select()
      .from(voiceovers)
      .where(eq(voiceovers.path, resolvedPath))
      .get();
  }

  if (!track) {
    // Silent return — filename may match a video or music file, not a voiceover
    return;
  }

  const analysis = db
    .select()
    .from(voiceoverAnalyses)
    .where(eq(voiceoverAnalyses.voiceoverId, track.id))
    .get();

  if (!analysis) {
    console.log(chalk.yellow(`Voiceover "${filename}" has not been analyzed yet.`));
    return;
  }

  console.log(chalk.cyan(`\n${track.filename}`) + chalk.dim(` (ID: ${track.id}${track.durationSeconds ? `, ${track.durationSeconds}s` : ''})`));

  console.log(`\n${chalk.bold('Overview')}`);
  console.log(analysis.overview);

  const transcription = JSON.parse(analysis.transcription) as Array<Record<string, unknown>>;
  if (transcription.length > 0) {
    console.log(`\n${chalk.bold('Transcription')}`);
    for (const seg of transcription) {
      const skipTag = seg.skip ? chalk.red(' [SKIP]') : '';
      console.log(chalk.green(`  ${seg.startTime}–${seg.endTime}`) + `  ${seg.text}${skipTag}`);
    }
  }

  console.log();
}

export function listVoiceovers(db: MontaiDb): void {
  const allVoiceovers = db.select().from(voiceovers).orderBy(asc(voiceovers.filename)).all();

  if (allVoiceovers.length === 0) {
    return;
  }

  console.log(chalk.blue('\nVoiceover recordings:'));
  for (const track of allVoiceovers) {
    const meta: string[] = [];
    if (track.durationSeconds) meta.push(`${track.durationSeconds}s`);
    if (track.sampleRate) meta.push(`${track.sampleRate}Hz`);
    if (track.channels) meta.push(`${track.channels}ch`);

    console.log(chalk.cyan(`${track.id}. ${track.filename}`) + (meta.length ? chalk.dim(` (${meta.join(', ')})`) : ''));

    const analysis = db
      .select()
      .from(voiceoverAnalyses)
      .where(eq(voiceoverAnalyses.voiceoverId, track.id))
      .get();

    if (!analysis) {
      console.log(chalk.dim('   (not analyzed)\n'));
      continue;
    }

    console.log(chalk.dim(`   ${analysis.overview.replace(/\n/g, ' ')}`));
    console.log();
  }
}

export async function syncAndAnalyzeVoiceovers(
  db: MontaiDb,
  config: ProjectConfig,
  model: Parameters<typeof complete>[0],
  options?: { reRun?: string; reRunAll?: boolean },
): Promise<{ totalCost: number }> {
  const voiceoverFiles = resolveVoiceoverFiles(config);
  if (voiceoverFiles.length === 0) {
    return { totalCost: 0 };
  }

  console.log(chalk.blue(`\nFound ${voiceoverFiles.length} voiceover file(s)`));

  for (const filepath of voiceoverFiles) {
    const filename = getVoiceoverFilename(filepath);
    const existing = db
      .select()
      .from(voiceovers)
      .where(eq(voiceovers.path, filepath))
      .get();

    if (!existing) {
      const spinner = ora(`Hashing ${filename}`).start();
      const md5 = await fileMd5(filepath);

      const md5Match = db
        .select()
        .from(voiceovers)
        .where(eq(voiceovers.md5, md5))
        .get();

      if (md5Match) {
        db.update(voiceovers)
          .set({ path: filepath, filename })
          .where(eq(voiceovers.id, md5Match.id))
          .run();
        spinner.succeed(`Re-linked ${filename} (was ${md5Match.filename})`);
      } else {
        try {
          const meta = getAudioMetadata(filepath);
          db.insert(voiceovers)
            .values({
              filename, path: filepath, md5,
              durationSeconds: meta.durationSeconds,
              sampleRate: meta.sampleRate,
              channels: meta.channels,
            })
            .run();
          spinner.succeed(`Registered ${filename} (${meta.durationSeconds}s, ${meta.sampleRate ?? '?'}Hz, ${meta.channels ?? '?'}ch)`);
        } catch {
          db.insert(voiceovers)
            .values({ filename, path: filepath, md5 })
            .run();
          spinner.warn(`Registered ${filename} (metadata unknown)`);
        }
      }
    }
  }

  let voiceoversToAnalyze;

  if (options?.reRunAll) {
    voiceoversToAnalyze = db
      .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
      .from(voiceovers)
      .orderBy(asc(voiceovers.filename))
      .all();
    for (const track of voiceoversToAnalyze) {
      db.delete(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, track.id)).run();
    }
  } else if (options?.reRun) {
    voiceoversToAnalyze = db
      .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
      .from(voiceovers)
      .where(eq(voiceovers.filename, basename(options.reRun)))
      .all();
    if (voiceoversToAnalyze.length === 0) {
      const resolvedPath = resolve(options.reRun);
      voiceoversToAnalyze = db
        .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
        .from(voiceovers)
        .where(eq(voiceovers.path, resolvedPath))
        .all();
    }
    if (voiceoversToAnalyze.length === 0) {
      return { totalCost: 0 };
    }
    for (const track of voiceoversToAnalyze) {
      db.delete(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, track.id)).run();
    }
  } else {
    voiceoversToAnalyze = db
      .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
      .from(voiceovers)
      .leftJoin(voiceoverAnalyses, eq(voiceovers.id, voiceoverAnalyses.voiceoverId))
      .where(isNull(voiceoverAnalyses.id))
      .orderBy(asc(voiceovers.filename))
      .all();
  }

  if (voiceoversToAnalyze.length === 0) {
    console.log(chalk.green(`All voiceover files already analyzed. Use ${chalk.bold('--re-run [filename]')} to re-analyze.`));
    return { totalCost: 0 };
  }

  const agentInstructions = readProjectFile('AGENTS.md');

  console.log(chalk.blue(`Analyzing ${voiceoversToAnalyze.length} voiceover file(s)...`));
  let totalCost = 0;
  let failed = 0;

  const pipelineState: { uploading: string | null; analyzing: string | null } = {
    uploading: null,
    analyzing: null,
  };
  const spinner = ora();

  function updateSpinner(): void {
    const parts: string[] = [];
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

  type VoiceoverItem = typeof voiceoversToAnalyze[number];

  const analyzeQueue = new AsyncQueue<{ track: VoiceoverItem; fileUri: string }>(async ({ track, fileUri }) => {
    pipelineState.analyzing = track.filename;
    updateSpinner();

    try {
      const ext = extname(track.path).toLowerCase();
      const mimeType = mimeTypeMap[ext] ?? 'audio/mpeg';
      const fileContent: FileContent = {
        type: 'file',
        uri: fileUri,
        mimeType,
      };

      const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const analysisPrompt = renderPrompt('analyze-voiceover', { language: config.language, agentInstructions: agentInstructions ?? null });

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

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(extractJson(analysisText));
      } catch {
        parsed = { overview: analysisText, transcription: [] };
      }

      db.insert(voiceoverAnalyses)
        .values({
          voiceoverId: track.id,
          overview: String(parsed.overview ?? ''),
          transcription: JSON.stringify(parsed.transcription ?? []),
        })
        .run();

      logLine(chalk.green(`  ✓ Analyzed ${track.filename} (${formatDuration(Date.now() - t0)}, ${formatCost(analysisResult.usage.cost.total)})`));
    } catch (err) {
      logLine(chalk.red(`  ✗ Failed to analyze ${track.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.analyzing = null;
      updateSpinner();
    }
  });

  const uploadQueue = new AsyncQueue<{ track: VoiceoverItem }>(async ({ track }) => {
    pipelineState.uploading = track.filename;
    updateSpinner();

    try {
      const t0 = Date.now();
      const uploaded = await uploadFileToGemini(track.path);
      if (uploaded.cached) {
        logLine(chalk.green(`  ✓ Uploaded ${track.filename} (cached)`));
      } else {
        logLine(chalk.green(`  ✓ Uploaded ${track.filename} (${formatDuration(Date.now() - t0)})`));
      }
      analyzeQueue.enqueue({ track, fileUri: uploaded.fileUri });
    } catch (err) {
      logLine(chalk.red(`  ✗ Failed to upload ${track.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.uploading = null;
      updateSpinner();
    }
  });

  for (const track of voiceoversToAnalyze) {
    uploadQueue.enqueue({ track });
  }
  uploadQueue.seal();

  uploadQueue.drain().then(() => analyzeQueue.seal());

  await analyzeQueue.drain();
  spinner.stop();

  if (failed > 0) {
    console.log(chalk.yellow(`Voiceover analysis complete with ${failed} failure(s), total cost: ${formatCost(totalCost)}.`));
  } else {
    console.log(chalk.green(`Voiceover analysis complete! Total cost: ${formatCost(totalCost)}`));
  }

  return { totalCost };
}
