import { mkdirSync, linkSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { Timeline } from '../schemas/timeline.js';

export function preparePublicDir(timeline: Timeline): string {
  const publicDir = resolve('.montai/public');
  mkdirSync(publicDir, { recursive: true });

  const seen = new Set<string>();

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
      console.error(`Error: Video file not found: ${absoluteSource}`);
      console.error('The stored timeline may contain outdated paths. Try re-running "montai story" to regenerate the timeline.');
      process.exit(1);
    }

    linkSync(absoluteSource, linkPath);
  }

  // Write timeline JSON for studio fallback (loaded by Root.tsx when no --props provided)
  writeFileSync(
    resolve(publicDir, 'timeline.json'),
    JSON.stringify(timeline, null, 2),
  );

  return publicDir;
}
