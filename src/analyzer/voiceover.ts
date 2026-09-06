import chalk from 'chalk';
import ora from 'ora';
import { asc, eq, isNull } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { voiceovers, voiceoverAnalyses } from '../db/schema.js';
import { resolveVoiceoverFiles, getVoiceoverFilename } from '../utils/project.js';
import { getAudioMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { resolve, basename } from 'path';
import type { ProjectConfig } from '../schemas/project.js';
import type { AnalyzeItem } from './pipeline.js';
import { isStale, type SyncOptions } from './provenance.js';

export function showVoiceoverAnalysis(db: MontaiDb, filename: string): boolean {
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
    return false;
  }

  const analysis = db
    .select()
    .from(voiceoverAnalyses)
    .where(eq(voiceoverAnalyses.voiceoverId, track.id))
    .get();

  if (!analysis) {
    console.log(chalk.yellow(`Voiceover "${filename}" has not been analyzed yet.`));
    return true;
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
  return true;
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

export async function syncVoiceovers(
  db: MontaiDb,
  config: ProjectConfig,
  options?: SyncOptions,
): Promise<AnalyzeItem[]> {
  const voiceoverFiles = resolveVoiceoverFiles(config);
  if (voiceoverFiles.length === 0) {
    return [];
  }

  console.log(chalk.blue(`\nFound ${voiceoverFiles.length} voiceover files`));

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

  if (options?.all) {
    voiceoversToAnalyze = db
      .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
      .from(voiceovers)
      .orderBy(asc(voiceovers.filename))
      .all();
    for (const track of voiceoversToAnalyze) {
      db.delete(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, track.id)).run();
    }
  } else if (options?.file) {
    voiceoversToAnalyze = db
      .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
      .from(voiceovers)
      .where(eq(voiceovers.filename, basename(options.file)))
      .all();
    if (voiceoversToAnalyze.length === 0) {
      const resolvedPath = resolve(options.file);
      voiceoversToAnalyze = db
        .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path })
        .from(voiceovers)
        .where(eq(voiceovers.path, resolvedPath))
        .all();
    }
    if (voiceoversToAnalyze.length === 0) {
      return [];
    }
    for (const track of voiceoversToAnalyze) {
      db.delete(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, track.id)).run();
    }
  } else if (options?.stale) {
    const signature = options.stale;
    const rows = db
      .select({ id: voiceovers.id, filename: voiceovers.filename, path: voiceovers.path, analysisId: voiceoverAnalyses.id, model: voiceoverAnalyses.model, promptHash: voiceoverAnalyses.promptHash })
      .from(voiceovers)
      .leftJoin(voiceoverAnalyses, eq(voiceovers.id, voiceoverAnalyses.voiceoverId))
      .orderBy(asc(voiceovers.filename))
      .all();
    voiceoversToAnalyze = rows.filter((row) => row.analysisId === null || isStale(row, signature));
    const stale = voiceoversToAnalyze.filter((row) => row.analysisId !== null);
    if (stale.length > 0) {
      const analyzed = rows.filter((row) => row.analysisId !== null).length;
      console.log(chalk.yellow(`${stale.length} of ${analyzed} voiceover analyses are stale`));
    }
    for (const row of stale) {
      db.delete(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, row.id)).run();
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
    console.log(chalk.green(`All voiceover files already analyzed. Use ${chalk.bold('--refresh [filename]')} to re-analyze.`));
    return [];
  }

  return voiceoversToAnalyze.map((track) => ({ kind: 'voiceover', id: track.id, filename: track.filename, path: track.path }));
}
