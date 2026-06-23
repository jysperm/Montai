import chalk from 'chalk';
import ora from 'ora';
import { asc, eq, isNull } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { videos, videoAnalyses } from '../db/schema.js';
import { resolveVideoFiles, getVideoFilename } from '../utils/project.js';
import { getVideoMetadata } from '../utils/ffprobe.js';
import { fileMd5 } from '../utils/hash.js';
import { resolve, basename } from 'path';
import type { ProjectConfig } from '../schemas/project.js';
import type { AnalyzeItem } from './pipeline.js';
import { formatDuration as formatDurationHuman } from '../utils/format.js';

export function parseTimeToSeconds(time: string): number {
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

export async function syncVideos(
  db: MontaiDb,
  config: ProjectConfig,
  options?: { reRun?: string; reRunAll?: boolean },
): Promise<AnalyzeItem[]> {
  const videoFiles = resolveVideoFiles(config);
  if (videoFiles.length === 0) {
    console.log(chalk.red('No videos found. Check your montai.yaml paths.'));
    return [];
  }

  console.log(chalk.blue(`Found ${videoFiles.length} videos`));

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

  if (options?.reRunAll) {
    videosToAnalyze = db
      .select()
      .from(videos)
      .orderBy(asc(videos.filename))
      .all();
  } else if (options?.reRun) {
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
      return [];
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
    console.log(chalk.green(`All videos already analyzed. Use ${chalk.bold('--re-run [filename]')} to re-analyze.`));
    return [];
  }

  return videosToAnalyze.map((video) => ({ kind: 'video', id: video.id, filename: video.filename, path: video.path }));
}
