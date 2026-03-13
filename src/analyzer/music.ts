import chalk from 'chalk';
import ora from 'ora';
import { asc, eq, isNull } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { music, musicSummaries } from '../db/schema.js';
import { resolveMusicFiles, getMusicFilename, readProjectFile } from '../utils/project.js';
import { getAudioMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { extname } from 'path';
import { uploadMusicToGemini } from '../gemini/upload.js';
import { musicAnalysisPrompt } from '../prompts/index.js';
import { complete, type FileContent, type Message } from '@mariozechner/pi-ai';
import type { ProjectConfig } from '../schemas/project.js';
import { AsyncQueue, assertComplete, getTextContent, extractJson, formatDuration, formatCost } from './utils.js';

const mimeTypeMap: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

export function showMusicSummary(db: MontaiDb, filename: string): void {
  const track = db
    .select()
    .from(music)
    .where(eq(music.filename, filename))
    .get();

  if (!track) {
    console.log(chalk.red(`Music "${filename}" not found.`));
    return;
  }

  const summary = db
    .select()
    .from(musicSummaries)
    .where(eq(musicSummaries.musicId, track.id))
    .get();

  if (!summary) {
    console.log(chalk.yellow(`Music "${filename}" has not been analyzed yet.`));
    return;
  }

  console.log(chalk.cyan(`\n${track.filename}`) + chalk.dim(` (ID: ${track.id}${track.durationSeconds ? `, ${track.durationSeconds}s` : ''})`));

  console.log(`\n${chalk.bold('Overview')}`);
  console.log(summary.overview);

  const segments = JSON.parse(summary.segments) as Array<Record<string, string>>;
  if (segments.length > 0) {
    console.log(`\n${chalk.bold('Segments')}`);
    for (const seg of segments) {
      console.log(chalk.green(`  ${seg.startTime}–${seg.endTime}`) + `  ${seg.description}`);
    }
  }

  console.log();
}

export function listMusic(db: MontaiDb): void {
  const allMusic = db.select().from(music).orderBy(asc(music.filename)).all();

  if (allMusic.length === 0) {
    console.log(chalk.yellow('No music in database.'));
    return;
  }

  for (const track of allMusic) {
    const meta: string[] = [];
    if (track.durationSeconds) meta.push(`${track.durationSeconds}s`);
    if (track.sampleRate) meta.push(`${track.sampleRate}Hz`);
    if (track.channels) meta.push(`${track.channels}ch`);

    console.log(chalk.cyan(`${track.id}. ${track.filename}`) + (meta.length ? chalk.dim(` (${meta.join(', ')})`) : ''));

    const summary = db
      .select()
      .from(musicSummaries)
      .where(eq(musicSummaries.musicId, track.id))
      .get();

    if (!summary) {
      console.log(chalk.dim('   (not analyzed)\n'));
      continue;
    }

    console.log(chalk.dim(`   ${summary.overview.replace(/\n/g, ' ')}`));
    console.log();
  }
}

export async function syncAndAnalyzeMusic(
  db: MontaiDb,
  config: ProjectConfig,
  model: Parameters<typeof complete>[0],
  options?: { reRun?: string },
): Promise<{ totalCost: number }> {
  const musicFiles = resolveMusicFiles(config);
  if (musicFiles.length === 0) {
    return { totalCost: 0 };
  }

  console.log(chalk.blue(`\nFound ${musicFiles.length} music file(s)`));

  for (const filepath of musicFiles) {
    const filename = getMusicFilename(filepath);
    const existing = db
      .select()
      .from(music)
      .where(eq(music.path, filepath))
      .get();

    if (!existing) {
      const spinner = ora(`Hashing ${filename}`).start();
      const md5 = await fileMd5(filepath);

      const md5Match = db
        .select()
        .from(music)
        .where(eq(music.md5, md5))
        .get();

      if (md5Match) {
        db.update(music)
          .set({ path: filepath, filename })
          .where(eq(music.id, md5Match.id))
          .run();
        spinner.succeed(`Re-linked ${filename} (was ${md5Match.filename})`);
      } else {
        try {
          const meta = getAudioMetadata(filepath);
          db.insert(music)
            .values({
              filename, path: filepath, md5,
              durationSeconds: meta.durationSeconds,
              sampleRate: meta.sampleRate,
              channels: meta.channels,
            })
            .run();
          spinner.succeed(`Registered ${filename} (${meta.durationSeconds}s, ${meta.sampleRate ?? '?'}Hz, ${meta.channels ?? '?'}ch)`);
        } catch {
          db.insert(music)
            .values({ filename, path: filepath, md5 })
            .run();
          spinner.warn(`Registered ${filename} (metadata unknown)`);
        }
      }
    }
  }

  let musicToAnalyze;

  if (options?.reRun) {
    musicToAnalyze = db
      .select({ id: music.id, filename: music.filename, path: music.path })
      .from(music)
      .where(eq(music.filename, options.reRun))
      .all();
    if (musicToAnalyze.length === 0) {
      console.log(chalk.red(`Music "${options.reRun}" not found.`));
      return { totalCost: 0 };
    }
    // Delete existing summaries so they get re-analyzed
    for (const track of musicToAnalyze) {
      db.delete(musicSummaries).where(eq(musicSummaries.musicId, track.id)).run();
    }
  } else {
    musicToAnalyze = db
      .select({ id: music.id, filename: music.filename, path: music.path })
      .from(music)
      .leftJoin(musicSummaries, eq(music.id, musicSummaries.musicId))
      .where(isNull(musicSummaries.id))
      .orderBy(asc(music.filename))
      .all();
  }

  if (musicToAnalyze.length === 0) {
    console.log(chalk.green('All music files already analyzed. Use --re-run <filename> to re-analyze.'));
    return { totalCost: 0 };
  }

  const agentInstructions = readProjectFile('AGENTS.md');

  console.log(chalk.blue(`Analyzing ${musicToAnalyze.length} music file(s)...`));
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

  type MusicItem = typeof musicToAnalyze[number];

  const analyzeQueue = new AsyncQueue<{ track: MusicItem; fileUri: string }>(async ({ track, fileUri }) => {
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
      const analysisPrompt = musicAnalysisPrompt(config.language, agentInstructions);

      const messages: Message[] = [
        {
          role: 'user',
          content: [fileContent, { type: 'text', text: analysisPrompt }],
          timestamp: Date.now(),
        },
      ];

      const t0 = Date.now();
      const analysisResult = await complete(model, { messages }, { apiKey });
      assertComplete(analysisResult);
      const analysisText = getTextContent(analysisResult);
      totalCost += analysisResult.usage.cost.total;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(extractJson(analysisText));
      } catch {
        parsed = { overview: analysisText };
      }

      db.insert(musicSummaries)
        .values({
          musicId: track.id,
          overview: String(parsed.overview ?? ''),
          segments: JSON.stringify(parsed.segments ?? []),
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

  const uploadQueue = new AsyncQueue<{ track: MusicItem }>(async ({ track }) => {
    pipelineState.uploading = track.filename;
    updateSpinner();

    try {
      const t0 = Date.now();
      const fileUri = await uploadMusicToGemini(track.id, track.path);
      logLine(chalk.green(`  ✓ Uploaded ${track.filename} (${formatDuration(Date.now() - t0)})`));
      analyzeQueue.enqueue({ track, fileUri });
    } catch (err) {
      logLine(chalk.red(`  ✗ Failed to upload ${track.filename}: ${err instanceof Error ? err.message : err}`));
      failed++;
    } finally {
      pipelineState.uploading = null;
      updateSpinner();
    }
  });

  for (const track of musicToAnalyze) {
    uploadQueue.enqueue({ track });
  }
  uploadQueue.seal();

  uploadQueue.drain().then(() => analyzeQueue.seal());

  await analyzeQueue.drain();
  spinner.stop();

  if (failed > 0) {
    console.log(chalk.yellow(`Music analysis complete with ${failed} failure(s), total cost: ${formatCost(totalCost)}.`));
  } else {
    console.log(chalk.green(`Music analysis complete! Total cost: ${formatCost(totalCost)}`));
  }

  return { totalCost };
}
