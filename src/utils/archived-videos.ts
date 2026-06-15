import chalk from 'chalk';
import { existsSync, readdirSync } from 'fs';
import { resolve, basename, join } from 'path';
import type { ResolvedTimeline } from '../schemas/timeline.js';

const ARCHIVE_DIR = 'archived';
const ARCHIVED_PATTERN = /^(.+)-(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s(\.\w+)$/;
const CONTAINMENT_TOLERANCE = 0.1; // 100ms tolerance for filename rounding

interface ArchivedFile {
  path: string;
  videoFilename: string;
  startSeconds: number;
  endSeconds: number;
}

function parseArchivedFilename(filename: string): Omit<ArchivedFile, 'path'> | null {
  const match = filename.match(ARCHIVED_PATTERN);
  if (!match) return null;
  return {
    videoFilename: match[1] + match[4],
    startSeconds: parseFloat(match[2]),
    endSeconds: parseFloat(match[3]),
  };
}

/**
 * Format seconds for archived filenames: up to 2 decimal places, trimming trailing zeros.
 * e.g., 0.0 → "0", 17.0 → "17", 8.2 → "8.2", 8.23 → "8.23"
 */
export function formatArchiveTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const fixed = clamped.toFixed(2);
  // Remove trailing zeros and unnecessary decimal point: 0.00→"0", 8.20→"8.2", 8.23→"8.23"
  return fixed.replace(/\.?0+$/, '');
}

/**
 * Remap expanded timelines to use archived video files from archived/.
 * Parses archived filenames to determine source video and time range,
 * then adjusts clip sourceFile and start/end times accordingly.
 */
export function remapToArchived(specs: ResolvedTimeline[]): ResolvedTimeline[] {
  const archiveDir = resolve(ARCHIVE_DIR);
  if (!existsSync(archiveDir)) {
    console.log(chalk.red(`${ARCHIVE_DIR}/ directory not found.`));
    process.exit(1);
  }

  const files = readdirSync(archiveDir);
  const archives: ArchivedFile[] = [];

  for (const file of files) {
    const parsed = parseArchivedFilename(file);
    if (parsed) {
      archives.push({
        ...parsed,
        path: resolve(archiveDir, file),
      });
    }
  }

  if (archives.length === 0) {
    console.log(chalk.red(`No archived video files found in ${ARCHIVE_DIR}/`));
    process.exit(1);
  }

  return specs.map(spec => ({
    ...spec,
    clips: spec.clips.map(clip => {
      const sourceFilename = basename(clip.sourceFile);
      const archive = archives.find(a =>
        a.videoFilename === sourceFilename &&
        a.startSeconds <= clip.startTimeSeconds + CONTAINMENT_TOLERANCE &&
        a.endSeconds >= clip.endTimeSeconds - CONTAINMENT_TOLERANCE
      );

      if (!archive) {
        console.log(chalk.yellow(
          `Warning: no archived file covers clip ${clip.clipId} ` +
          `(${sourceFilename} ${clip.startTimeSeconds}s-${clip.endTimeSeconds}s)`
        ));
        return clip;
      }

      return {
        ...clip,
        sourceFile: archive.path,
        startTimeSeconds: clip.startTimeSeconds - archive.startSeconds,
        endTimeSeconds: clip.endTimeSeconds - archive.startSeconds,
      };
    }),
  }));
}
