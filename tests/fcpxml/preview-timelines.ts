import { existsSync, mkdirSync, linkSync, unlinkSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  expandForTimeline,
  listTimelineNames,
} from './utils.js';

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : listTimelineNames();
const timelines = names.map((name) => {
  const { timeline, errors } = expandForTimeline(name);
  if (errors.length > 0) {
    throw new Error(`${name} errors:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  return timeline;
});

const publicDir = resolve('tests/fcpxml/.preview-public');
mkdirSync(publicDir, { recursive: true });

const seen = new Set<string>();
function linkSource(sourceFile: string) {
  const filename = basename(sourceFile);
  if (seen.has(filename)) return;
  seen.add(filename);
  const linkPath = resolve(publicDir, filename);
  if (existsSync(linkPath)) unlinkSync(linkPath);
  if (!existsSync(sourceFile)) {
    throw new Error(`Missing ${sourceFile}. Run: make -C tests/fixtures`);
  }
  linkSync(sourceFile, linkPath);
}

for (const timeline of timelines) {
  for (const clip of timeline.clips) {
    linkSource(clip.sourceFile);
  }
  for (const track of timeline.audioTracks ?? []) {
    linkSource(track.sourceFile);
  }
  for (const track of timeline.voiceoverTracks ?? []) {
    linkSource(track.sourceFile);
  }
}

writeFileSync(resolve(publicDir, 'timelines.json'), JSON.stringify(timelines, null, 2));

const remotionDir = fileURLToPath(new URL('../../remotion', import.meta.url));
const result = spawnSync('npm', ['exec', '--', 'remotion', 'studio', 'src/index.tsx', `--public-dir=${publicDir}`], {
  cwd: remotionDir,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
