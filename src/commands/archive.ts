import chalk from 'chalk';
import { spawn, execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { resolve, basename, extname, join } from 'path';
import { getDb } from '../db/index.js';
import { videos } from '../db/schema.js';
import { loadProjectConfig, loadExpandedTimelines } from '../utils/project.js';
import { formatArchiveTime } from '../utils/archived-videos.js';
import type { ProjectConfig } from '../schemas/project.js';

const ARCHIVE_DIR = 'archived';
const PADDING_SECONDS = 2;

interface MergedSegment {
  videoId: number;
  filename: string;
  path: string;
  startSeconds: number;
  endSeconds: number;
}

interface EncodeOptions {
  resolution?: string;
  crf: number;
  fps?: number;
  bitDepth: 8 | 10;
}

/**
 * Parse --encode spec string into encoding options.
 *
 * Special values:
 *   (no value / true) — same as "output"
 *   "output"          — use project output settings (resolution + fps, crf=20)
 *
 * Spec format: comma-separated params, e.g. "720p,crf=22,fps=30,10bit"
 *   Resolution: 720p, 1080p, 1440p, 4k
 *   CRF:        crf=<n>
 *   FPS:        fps=<n>
 *   Bit depth:  8bit, 10bit
 */
function parseEncodeSpec(spec: string | true, config: ProjectConfig): EncodeOptions {
  const opts: EncodeOptions = { crf: 20, bitDepth: 8 };

  if (spec === true || spec === 'output') {
    opts.resolution = config.output.resolution;
    opts.fps = config.output.fps;
    return opts;
  }

  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (/^\d+p$/i.test(trimmed) || trimmed.toLowerCase() === '4k') {
      opts.resolution = trimmed.toLowerCase();
    } else if (/^crf=\d+$/.test(trimmed)) {
      opts.crf = parseInt(trimmed.slice(4), 10);
    } else if (/^fps=\d+$/.test(trimmed)) {
      opts.fps = parseInt(trimmed.slice(4), 10);
    } else if (trimmed === '10bit') {
      opts.bitDepth = 10;
    } else if (trimmed === '8bit') {
      opts.bitDepth = 8;
    }
  }
  return opts;
}

function parseResolutionHeight(resolution: string): number {
  const map: Record<string, number> = {
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '4k': 2160,
  };
  return map[resolution] ?? (parseInt(resolution, 10) || 1080);
}

let cachedEncoders: string | null = null;

function getAvailableEncoders(): string {
  if (cachedEncoders === null) {
    try {
      cachedEncoders = execSync('ffmpeg -hide_banner -encoders 2>/dev/null', { encoding: 'utf-8' });
    } catch {
      cachedEncoders = '';
    }
  }
  return cachedEncoders;
}

function resolveEncoder(opts: EncodeOptions): { codec: string; pixFmt: string; qualityArgs: string[] } {
  if (opts.bitDepth === 10) {
    const encoders = getAvailableEncoders();
    if (encoders.includes('libx265')) {
      return {
        codec: 'libx265',
        pixFmt: 'yuv420p10le',
        qualityArgs: ['-crf', String(opts.crf), '-preset', 'medium'],
      };
    }
    if (encoders.includes('hevc_videotoolbox')) {
      // Map CRF (0=lossless, 51=worst) to VideoToolbox quality (0=worst, 100=best)
      const vtQuality = Math.max(0, Math.min(100, Math.round(100 - opts.crf * 2)));
      return {
        codec: 'hevc_videotoolbox',
        pixFmt: 'p010le',
        qualityArgs: ['-q:v', String(vtQuality)],
      };
    }
    console.warn(chalk.yellow('Warning: no 10-bit HEVC encoder found (libx265 or hevc_videotoolbox), falling back to libx264 8-bit'));
    return {
      codec: 'libx264',
      pixFmt: 'yuv420p',
      qualityArgs: ['-crf', String(opts.crf), '-preset', 'medium'],
    };
  }

  return {
    codec: 'libx264',
    pixFmt: 'yuv420p',
    qualityArgs: ['-crf', String(opts.crf), '-preset', 'medium'],
  };
}

export async function archiveCommand(
  options?: { encode?: string | boolean },
) {
  const config = loadProjectConfig();
  const db = getDb();

  const specs = loadExpandedTimelines(db, config);
  if (!specs) return;

  const allVideos = db.select().from(videos).all();
  const videoMap = new Map(allVideos.map(v => [v.id, v]));

  // Collect clip time ranges per video across all timelines
  const segmentsPerVideo = new Map<number, { start: number; end: number }[]>();

  for (const spec of specs) {
    for (const clip of spec.clips) {
      const existing = segmentsPerVideo.get(clip.videoId) || [];
      existing.push({
        start: clip.startTimeSeconds,
        end: clip.endTimeSeconds,
      });
      segmentsPerVideo.set(clip.videoId, existing);
    }
  }

  // Add padding, clamp, and merge overlapping segments per video
  const mergedSegments: MergedSegment[] = [];

  for (const [videoId, segments] of segmentsPerVideo) {
    const video = videoMap.get(videoId);
    if (!video) {
      console.warn(chalk.yellow(`Warning: video id ${videoId} not found in database, skipping`));
      continue;
    }

    if (!existsSync(video.path)) {
      console.warn(chalk.yellow(`Warning: video file not found: ${video.path}, skipping`));
      continue;
    }

    // Add padding and clamp to [0, duration]
    const padded = segments.map(s => ({
      start: Math.max(0, s.start - PADDING_SECONDS),
      end: video.durationSeconds
        ? Math.min(s.end + PADDING_SECONDS, video.durationSeconds)
        : s.end + PADDING_SECONDS,
    }));

    // Sort by start time
    padded.sort((a, b) => a.start - b.start);

    // Merge overlapping ranges
    const merged: { start: number; end: number }[] = [];
    for (const seg of padded) {
      if (merged.length > 0 && seg.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
      } else {
        merged.push({ ...seg });
      }
    }

    for (const seg of merged) {
      mergedSegments.push({
        videoId,
        filename: video.filename,
        path: video.path,
        startSeconds: seg.start,
        endSeconds: seg.end,
      });
    }
  }

  if (mergedSegments.length === 0) {
    console.log(chalk.yellow('No clips found in timelines.'));
    return;
  }

  const outputDir = resolve(ARCHIVE_DIR);
  mkdirSync(outputDir, { recursive: true });

  const encodeSpec = options?.encode;
  const encode = !!encodeSpec;
  const encodeOpts = encode ? parseEncodeSpec(encodeSpec!, config) : null;

  console.log(chalk.blue(
    `Archiving ${mergedSegments.length} segment(s) ${encode ? '(encoding)' : '(passthrough)'}...`
  ));

  for (const segment of mergedSegments) {
    await extractSegment(segment, outputDir, encodeOpts);
  }

  console.log(chalk.green(
    `\nArchive complete: ${mergedSegments.length} segment(s) in ${ARCHIVE_DIR}/`
  ));
}

async function extractSegment(
  segment: MergedSegment,
  outputDir: string,
  encodeOpts: EncodeOptions | null,
) {
  const ext = extname(segment.filename);
  const base = basename(segment.filename, ext);

  if (encodeOpts) {
    // Encode: frame-accurate cuts, use requested times for filename
    const finalName = `${base}-${formatArchiveTime(segment.startSeconds)}s-${formatArchiveTime(segment.endSeconds)}s${ext}`;
    const finalPath = join(outputDir, finalName);

    const vfFilters: string[] = [];

    if (encodeOpts.resolution) {
      vfFilters.push(`scale=-2:${parseResolutionHeight(encodeOpts.resolution)}`);
    }
    if (encodeOpts.fps) {
      vfFilters.push(`fps=${encodeOpts.fps}`);
    }

    const { codec, pixFmt, qualityArgs } = resolveEncoder(encodeOpts);

    const args = [
      '-y',
      '-ss', String(segment.startSeconds),
      '-i', segment.path,
      '-t', String(segment.endSeconds - segment.startSeconds),
      '-c:v', codec,
      ...qualityArgs,
      '-pix_fmt', pixFmt,
    ];

    if (vfFilters.length > 0) {
      args.push('-vf', vfFilters.join(','));
    }

    args.push('-c:a', 'aac', '-b:a', '192k', finalPath);

    await runFfmpeg(args);
    console.log(chalk.cyan(`  ${finalName}`));
  } else {
    // Passthrough: find keyframe position, extract, determine actual range
    const actualStart = findKeyframeBefore(segment.path, segment.startSeconds);
    const duration = segment.endSeconds - actualStart;

    const tmpName = `_tmp_${base}${ext}`;
    const tmpPath = join(outputDir, tmpName);

    const cleanupTmp = () => {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    };

    try {
      await runFfmpeg([
        '-y',
        '-ss', String(actualStart),
        '-i', segment.path,
        '-t', String(duration),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        tmpPath,
      ]);
    } catch (err) {
      cleanupTmp();
      throw err;
    }

    // Probe output for actual duration to determine precise end time
    const actualDuration = probeFormatDuration(tmpPath);
    const actualEnd = actualStart + actualDuration;

    const finalName = `${base}-${formatArchiveTime(actualStart)}s-${formatArchiveTime(actualEnd)}s${ext}`;
    const finalPath = join(outputDir, finalName);

    // Rename tmp to final (delete existing if needed)
    if (existsSync(finalPath)) unlinkSync(finalPath);
    renameSync(tmpPath, finalPath);

    console.log(chalk.cyan(`  ${finalName}`));
  }
}

/**
 * Find the PTS of the last keyframe at or before targetTime in the video.
 * Uses ffprobe to scan a 30-second window before the target.
 * Falls back to targetTime if no keyframe is found.
 */
function findKeyframeBefore(filepath: string, targetTime: number): number {
  const windowStart = Math.max(0, targetTime - 30);
  const windowEnd = targetTime + 0.5;

  try {
    const output = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time',
      '-read_intervals', `${windowStart}%${windowEnd}`,
      '-of', 'csv=p=0',
      filepath,
    ], { encoding: 'utf-8' });

    let lastKeyframePts = targetTime;
    for (const line of output.trim().split('\n')) {
      const pts = parseFloat(line.trim());
      if (!isNaN(pts) && pts <= targetTime + 0.001) {
        lastKeyframePts = pts;
      }
    }
    return lastKeyframePts;
  } catch {
    return targetTime;
  }
}

function probeFormatDuration(filepath: string): number {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    filepath,
  ], { encoding: 'utf-8' });

  const data = JSON.parse(output);
  return parseFloat(data.format?.duration ?? '0');
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrTail = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrTail = data.toString().slice(-2000);
    });

    const onSignal = () => {
      child.kill();
      process.exit(1);
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    child.on('close', (code) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (code === 0) {
        resolve();
      } else {
        const detail = stderrTail.trim();
        reject(new Error(`ffmpeg exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });

    child.on('error', (err) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      reject(err);
    });
  });
}
