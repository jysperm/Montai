import chalk from 'chalk';
import { existsSync, rmSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { formatFileSize } from '../utils/format.js';

// Regenerable cache directories, relative to the project directory. Listed
// separately so more cache locations can be added later; user data
// (montai.db) and outputs (output/, fcpxml/, archived/, generated-music/,
// generated-voiceover/) are intentionally excluded.
const CACHE_DIRS = ['.montai'];

function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(child);
    } else {
      try {
        total += statSync(child).size;
      } catch {
        // file vanished mid-walk; ignore
      }
    }
  }
  return total;
}

export async function cleanCommand() {
  const targets = CACHE_DIRS
    .map((dir) => resolve(dir))
    .filter((path) => existsSync(path));

  if (targets.length === 0) {
    console.log(chalk.dim('Nothing to clean — no cache files found.'));
    return;
  }

  // Cache is always safe to regenerate, so remove without confirmation.
  let totalSize = 0;
  for (const path of targets) {
    totalSize += dirSize(path);
    rmSync(path, { recursive: true, force: true });
  }
  console.log(chalk.green(`Removed ${formatFileSize(totalSize)} of cache files.`));
}
