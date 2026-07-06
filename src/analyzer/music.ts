import chalk from 'chalk';
import ora from 'ora';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { music, musicAnalyses } from '../db/schema.js';
import { resolveMusicFiles, getMusicFilename } from '../utils/project.js';
import { getAudioMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { resolve, basename } from 'path';
import type { ProjectConfig } from '../schemas/project.js';
import type { AnalyzeItem } from './pipeline.js';

export function showMusicAnalysis(db: MontaiDb, filename: string): boolean {
  // First try matching by filename (basename)
  let track = db
    .select()
    .from(music)
    .where(eq(music.filename, basename(filename)))
    .get();
  // If no match, try resolving as a path
  if (!track) {
    const resolvedPath = resolve(filename);
    track = db
      .select()
      .from(music)
      .where(eq(music.path, resolvedPath))
      .get();
  }

  if (!track) {
    return false;
  }

  const analysis = db
    .select()
    .from(musicAnalyses)
    .where(eq(musicAnalyses.musicId, track.id))
    .get();

  if (!analysis) {
    console.log(chalk.yellow(`Music "${filename}" has not been analyzed yet.`));
    return true;
  }

  console.log(chalk.cyan(`\n${track.filename}`) + chalk.dim(` (ID: ${track.id}${track.durationSeconds ? `, ${track.durationSeconds}s` : ''})`));

  console.log(`\n${chalk.bold('Overview')}`);
  console.log(analysis.overview);

  const segments = JSON.parse(analysis.segments) as Array<Record<string, string>>;
  if (segments.length > 0) {
    console.log(`\n${chalk.bold('Segments')}`);
    for (const seg of segments) {
      console.log(chalk.green(`  ${seg.startTime}–${seg.endTime}`) + `  ${seg.description}`);
    }
  }

  console.log();
  return true;
}

export function listMusic(db: MontaiDb): void {
  const allMusic = db.select().from(music).orderBy(asc(music.filename)).all();

  if (allMusic.length === 0) {
    console.log(chalk.dim('No music files in database.'));
    return;
  }

  for (const track of allMusic) {
    const meta: string[] = [];
    if (track.durationSeconds) meta.push(`${track.durationSeconds}s`);
    if (track.sampleRate) meta.push(`${track.sampleRate}Hz`);
    if (track.channels) meta.push(`${track.channels}ch`);

    console.log(chalk.cyan(`${track.id}. ${track.filename}`) + (meta.length ? chalk.dim(` (${meta.join(', ')})`) : ''));

    const analysis = db
      .select()
      .from(musicAnalyses)
      .where(eq(musicAnalyses.musicId, track.id))
      .get();

    if (!analysis) {
      console.log(chalk.dim('   (not analyzed)\n'));
      continue;
    }

    console.log(chalk.dim(`   ${analysis.overview.replace(/\n/g, ' ')}`));
    console.log();
  }
}

export async function syncMusic(
  db: MontaiDb,
  config: ProjectConfig,
  options?: { reRun?: string; reRunAll?: boolean },
): Promise<AnalyzeItem[]> {
  const musicFiles = resolveMusicFiles(config);
  if (musicFiles.length === 0) {
    return [];
  }

  console.log(chalk.blue(`\nFound ${musicFiles.length} music files`));

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

  if (options?.reRunAll) {
    musicToAnalyze = db
      .select({ id: music.id, filename: music.filename, path: music.path })
      .from(music)
      .where(or(eq(music.type, 'library'), isNull(music.type)))
      .orderBy(asc(music.filename))
      .all();
    for (const track of musicToAnalyze) {
      db.delete(musicAnalyses).where(eq(musicAnalyses.musicId, track.id)).run();
    }
  } else if (options?.reRun) {
    // First try matching by filename (basename)
    musicToAnalyze = db
      .select({ id: music.id, filename: music.filename, path: music.path })
      .from(music)
      .where(eq(music.filename, basename(options.reRun)))
      .all();
    // If no match, try resolving as a path
    if (musicToAnalyze.length === 0) {
      const resolvedPath = resolve(options.reRun);
      musicToAnalyze = db
        .select({ id: music.id, filename: music.filename, path: music.path })
        .from(music)
        .where(eq(music.path, resolvedPath))
        .all();
    }
    if (musicToAnalyze.length === 0) {
      console.log(chalk.red(`Music "${options.reRun}" not found.`));
      return [];
    }
    // Delete existing analyses so they get re-analyzed
    for (const track of musicToAnalyze) {
      db.delete(musicAnalyses).where(eq(musicAnalyses.musicId, track.id)).run();
    }
  } else {
    musicToAnalyze = db
      .select({ id: music.id, filename: music.filename, path: music.path })
      .from(music)
      .leftJoin(musicAnalyses, eq(music.id, musicAnalyses.musicId))
      .where(and(
        isNull(musicAnalyses.id),
        or(eq(music.type, 'library'), isNull(music.type)),
      ))
      .orderBy(asc(music.filename))
      .all();
  }

  if (musicToAnalyze.length === 0) {
    console.log(chalk.green(`All music files already analyzed. Use ${chalk.bold('--re-run [filename]')} to re-analyze.`));
    return [];
  }

  return musicToAnalyze.map((track) => ({ kind: 'music', id: track.id, filename: track.filename, path: track.path }));
}
