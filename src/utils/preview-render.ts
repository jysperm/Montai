import { existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { bundle } from '@remotion/bundler';
import { renderStill, renderMedia, selectComposition } from '@remotion/renderer';
import type { ExpandedTimeline, ExpandedClip } from '../schemas/timeline.js';

const REMOTION_DIR = fileURLToPath(new URL('../../remotion', import.meta.url));
const BUNDLE_OUT = resolve('.montai/.cache/remotion-bundle');
const PUBLIC_DIR = resolve('.montai/public');

function clipDurationFrames(clip: ExpandedClip, fps: number): number {
  const seconds = (clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate;
  return Math.round(seconds * fps);
}

function transitionFrames(clip: ExpandedClip, fps: number): number {
  return clip.transition ? Math.round(clip.transition.durationSeconds * fps) : 0;
}

// Global frame at which clip k's content starts. Mirrors MontaiVideo.calculateTotalFrames.
export function clipStartFrame(spec: ExpandedTimeline, k: number): number {
  let frame = 0;
  for (let i = 0; i < k; i++) {
    frame += clipDurationFrames(spec.clips[i], spec.fps);
    if (i > 0) frame -= transitionFrames(spec.clips[i], spec.fps);
  }
  if (k > 0) frame -= transitionFrames(spec.clips[k], spec.fps);
  return frame;
}

export function totalTimelineFrames(spec: ExpandedTimeline): number {
  let total = 0;
  for (let i = 0; i < spec.clips.length; i++) {
    total += clipDurationFrames(spec.clips[i], spec.fps);
    if (i > 0) total -= transitionFrames(spec.clips[i], spec.fps);
  }
  return Math.max(total, 1);
}

export function totalTimelineSeconds(spec: ExpandedTimeline): number {
  return totalTimelineFrames(spec) / spec.fps;
}

// (clipIndex, timeOffset) → absolute frame. timeOffset follows OverlayItem.startOffset:
// >=0 from clip start, <0 from clip end.
export function resolveStartFrame(spec: ExpandedTimeline, clipIndex: number, timeOffset: number): number {
  const clip = spec.clips[clipIndex];
  if (!clip) throw new Error(`clipIndex ${clipIndex} out of range (timeline has ${spec.clips.length} clips)`);
  const startFrame = clipStartFrame(spec, clipIndex);
  const dur = clipDurationFrames(clip, spec.fps);
  const offsetFrames = Math.round(timeOffset * spec.fps);
  const target = timeOffset >= 0 ? startFrame + offsetFrames : startFrame + dur + offsetFrames;
  return Math.max(0, Math.min(totalTimelineFrames(spec) - 1, target));
}

// One bundle per process. Cached as a Promise so concurrent callers share the
// same first-run cost (~5-15s). Subsequent processes reuse the on-disk bundle
// via webpack's caching layer in BUNDLE_OUT.
let bundlePromise: Promise<string> | null = null;

function ensurePublicSymlink(bundleDir: string): void {
  // The Remotion entry has no `public/` of its own, but renderer-served URLs
  // (and staticFile()) resolve under <bundle>/public. Pointing it at the live
  // .montai/public/ means new media files become available without rebundling.
  const link = resolve(bundleDir, 'public');
  mkdirSync(PUBLIC_DIR, { recursive: true });
  if (existsSync(link)) {
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(PUBLIC_DIR, link);
}

async function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      mkdirSync(dirname(BUNDLE_OUT), { recursive: true });
      const dir = await bundle({
        entryPoint: resolve(REMOTION_DIR, 'src/index.tsx'),
        outDir: BUNDLE_OUT,
        publicDir: PUBLIC_DIR,
      });
      ensurePublicSymlink(dir);
      return dir;
    })().catch((err) => {
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}

// For renderPreview: copy the spec but force the composition fps. MontaiVideo
// derives all per-frame quantities from `fps * seconds`, so total frames and
// transition overlaps adjust automatically. Lower fps = fewer frames rendered
// (no waste) at the cost of animation sample density.
function specWithFps(spec: ExpandedTimeline, fps: number): ExpandedTimeline {
  return { ...spec, fps };
}

export interface RenderStillOpts {
  spec: ExpandedTimeline;
  frame: number;
  outPath: string;
}

export async function renderStillFrame({ spec, frame, outPath }: RenderStillOpts): Promise<void> {
  const serveUrl = await getBundle();
  const composition = await selectComposition({
    serveUrl,
    id: spec.name,
    inputProps: spec as unknown as Record<string, unknown>,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  await renderStill({
    composition,
    serveUrl,
    output: outPath,
    frame,
    inputProps: spec as unknown as Record<string, unknown>,
  });
}

export interface RenderRangeOpts {
  spec: ExpandedTimeline;
  startSeconds: number;
  endSeconds: number;
  fps: number;
  outPath: string;
}

// Renders the requested time range at composition fps == requested preview fps,
// so we render exactly the frames needed (no full-fps + ffmpeg drop).
export async function renderRange({ spec, startSeconds, endSeconds, fps, outPath }: RenderRangeOpts): Promise<void> {
  const previewSpec = specWithFps(spec, fps);
  const serveUrl = await getBundle();
  const composition = await selectComposition({
    serveUrl,
    id: previewSpec.name,
    inputProps: previewSpec as unknown as Record<string, unknown>,
  });

  const startFrame = Math.max(0, Math.floor(startSeconds * fps));
  const endFrame = Math.min(composition.durationInFrames - 1, Math.ceil(endSeconds * fps) - 1);
  if (endFrame < startFrame) {
    throw new Error(`Empty preview range: ${startSeconds}s–${endSeconds}s at ${fps}fps yielded frames ${startFrame}-${endFrame}.`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: previewSpec as unknown as Record<string, unknown>,
    frameRange: [startFrame, endFrame],
    // Cap output at 720p (scale relative to the spec's native height). For
    // already-≤720p compositions we don't scale up.
    scale: Math.min(1, 720 / previewSpec.height),
  });
}

// Stable hash over (spec + range + fps) for cross-session preview caching.
export function previewHash(spec: ExpandedTimeline, startSeconds: number, endSeconds: number, fps: number): string {
  const data = JSON.stringify({ spec, startSeconds, endSeconds, fps });
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// Stable hash over (spec + frame) for cross-session still caching.
export function stillHash(spec: ExpandedTimeline, frame: number): string {
  const data = JSON.stringify({ spec, frame });
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
