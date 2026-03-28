import chalk from 'chalk';
import { mkdirSync, linkSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { ExpandedTimeline } from '../schemas/timeline.js';

export function preparePublicDir(timelines: ExpandedTimeline | ExpandedTimeline[]): string {
  const timelineArray = Array.isArray(timelines) ? timelines : [timelines];
  const publicDir = resolve('.montai/public');
  mkdirSync(publicDir, { recursive: true });

  const seen = new Set<string>();

  for (const timeline of timelineArray) {
    for (const clip of timeline.clips) {
      const filename = basename(clip.sourceFile);
      if (seen.has(filename)) continue;
      seen.add(filename);

      const linkPath = resolve(publicDir, filename);
      const absoluteSource = resolve(clip.sourceFile);

      if (existsSync(linkPath)) {
        unlinkSync(linkPath);
      }

      if (!existsSync(absoluteSource)) {
        console.log(chalk.red(`Video file not found: ${absoluteSource}`));
        console.log(`The stored timeline may contain outdated paths. Try re-running ${chalk.bold('montai story')} to regenerate the timeline.`);
        process.exit(1);
      }

      linkSync(absoluteSource, linkPath);
    }

    // Hardlink audio files referenced by audioTracks
    for (const audio of timeline.audioTracks ?? []) {
      if (!audio.sourceFile) continue;
      const filename = basename(audio.sourceFile);
      if (seen.has(filename)) continue;
      seen.add(filename);

      const linkPath = resolve(publicDir, filename);
      const absoluteSource = resolve(audio.sourceFile);

      if (existsSync(linkPath)) {
        unlinkSync(linkPath);
      }

      if (!existsSync(absoluteSource)) {
        console.log(chalk.red(`Audio file not found: ${absoluteSource}`));
        console.log(`The stored timeline may contain outdated paths. Try re-running ${chalk.bold('montai story')} to regenerate the timeline.`);
        process.exit(1);
      }

      linkSync(absoluteSource, linkPath);
    }
  }

  // Write timelines.json for Root.tsx to load compositions dynamically
  writeFileSync(
    resolve(publicDir, 'timelines.json'),
    JSON.stringify(timelineArray, null, 2),
  );

  return publicDir;
}
