import { readdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { expandTimeline, type TimelineItem } from '../../src/schemas/timeline-items.js';
import { resolutionPresets, type ProjectConfig } from '../../src/schemas/project.js';
import { musicFiles, musicMeta, videos, voiceoverFiles, voiceoverMeta } from '../fixtures/index.js';

export { videoMeta, voiceoverMeta, outputDir as fixturesOutputDir } from '../fixtures/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const timelinesDir = resolve(__dirname, 'timelines');
export const outputDir = resolve(__dirname, 'output');

// A timeline's identity is its full filename stem. An optional second extension
// declares output intent: `name.matrix.json` is exported at every resolution
// (resolution-dependent conform tests), `name.<preset>.json` is pinned to that
// resolution (e.g. a vertical-footage overlay test). The marker is part of the
// name for loading; the Makefile reads it to build specs and parseTimelineSpec
// strips it from the output filename.
export function loadTimeline(name: string): TimelineItem[] {
  const raw = readFileSync(resolve(timelinesDir, `${name}.json`), 'utf-8');
  return JSON.parse(raw);
}

export function listTimelineNames(): string[] {
  return readdirSync(timelinesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

export const config: ProjectConfig = {
  assets: { videos: ['.'], music: [], voiceover: [] },
  language: 'en',
  output: { resolution: '1080p', fps: 30 },
  models: { analysis: 'gemini-3-flash-preview', editing: 'gemini-3.1-pro-preview' },
  effects: { languages: ['en'] },
  featureFlags: {},
};

export const audioMeta = musicMeta;

export interface TimelineSpec {
  name: string;
  resolution?: ProjectConfig['output']['resolution'];
  outputName: string;
}

export function parseTimelineSpec(spec: string): TimelineSpec {
  const [name, resolution] = spec.split('@');
  // `name` is the full stem (may carry an intent token, e.g. `spatial-test.matrix`);
  // the output name drops the token (`spatial-test`) so files stay clean.
  const base = name.split('.')[0];
  if (!resolution) return { name, outputName: base };
  if (!(resolution in resolutionPresets)) {
    throw new Error(`Unknown resolution "${resolution}" in "${spec}"`);
  }
  return {
    name,
    resolution: resolution as ProjectConfig['output']['resolution'],
    outputName: `${base}-${resolution}`,
  };
}

export function expand(items: TimelineItem[], name: string) {
  return expandTimeline(items, config, name, videos, undefined, musicFiles, voiceoverFiles);
}

export function expandForTimeline(
  name: string,
  resolution: ProjectConfig['output']['resolution'] = config.output.resolution,
) {
  const items = loadTimeline(name);
  return expandTimeline(
    items,
    { ...config, output: { ...config.output, resolution } },
    name,
    videos,
    undefined,
    musicFiles,
    voiceoverFiles,
  );
}
