import { mkdirSync, linkSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { ResolvedClip, ResolvedTimeline } from '../schemas/timeline.js';
import { findReusableTranscode } from '../utils/transcode.js';

export const PREVIEW_PUBLIC_DIR = resolve('.montai/preview-public');
export const AGENT_PUBLIC_DIR = resolve('.montai/agent-public');

interface PreparePublicDirOptions {
  publicDir?: string;
  resolveVideoSource?: (clip: ResolvedClip) => string;
}

export function collectMediaFiles(timelines: ResolvedTimeline[]): Set<string> {
  const files = new Set<string>();
  for (const t of timelines) {
    for (const clip of t.clips) files.add(basename(clip.sourceFile));
    for (const a of t.audioTracks ?? []) if (a.sourceFile) files.add(basename(a.sourceFile));
    for (const v of t.voiceoverTracks ?? []) if (v.sourceFile) files.add(basename(v.sourceFile));
  }
  return files;
}

export function writeTimelinesJson(timelines: ResolvedTimeline[]): void {
  mkdirSync(PREVIEW_PUBLIC_DIR, { recursive: true });
  writeFileSync(resolve(PREVIEW_PUBLIC_DIR, 'timelines.json'), JSON.stringify(timelines, null, 2));
}

export function preparePublicDir(timelines: ResolvedTimeline | ResolvedTimeline[], options?: PreparePublicDirOptions): string {
  const timelineArray = Array.isArray(timelines) ? timelines : [timelines];
  const publicDir = options?.publicDir ?? PREVIEW_PUBLIC_DIR;
  mkdirSync(publicDir, { recursive: true });

  const seen = new Set<string>();

  for (const timeline of timelineArray) {
    for (const clip of timeline.clips) {
      const filename = basename(clip.sourceFile);
      if (seen.has(filename)) continue;
      seen.add(filename);

      const linkPath = resolve(publicDir, filename);
      const absoluteSource = resolve(options?.resolveVideoSource?.(clip) ?? clip.sourceFile);

      if (existsSync(linkPath)) {
        unlinkSync(linkPath);
      }

      if (!existsSync(absoluteSource)) throw new Error(`Video file not found: ${absoluteSource}`);

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

      if (!existsSync(absoluteSource)) throw new Error(`Audio file not found: ${absoluteSource}`);

      linkSync(absoluteSource, linkPath);
    }

    // Hardlink voiceover files referenced by voiceoverTracks
    for (const vo of timeline.voiceoverTracks ?? []) {
      if (!vo.sourceFile) continue;
      const filename = basename(vo.sourceFile);
      if (seen.has(filename)) continue;
      seen.add(filename);

      const linkPath = resolve(publicDir, filename);
      const absoluteSource = resolve(vo.sourceFile);

      if (existsSync(linkPath)) {
        unlinkSync(linkPath);
      }

      if (!existsSync(absoluteSource)) throw new Error(`Voiceover file not found: ${absoluteSource}`);

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

// Agent video previews render at a deliberately low sampling rate. Reuse the
// full-duration, browser-friendly H.264 transcodes produced by analyze/watchSegment
// when their cached fps is high enough; otherwise retain the original media.
// The public filename stays equal to the original basename, so the timeline and
// all source-time trims remain unchanged.
export function prepareAgentPublicDir(timeline: ResolvedTimeline, previewFps: number): { publicDir: string; proxyCount: number } {
  let proxyCount = 0;
  const publicDir = preparePublicDir(timeline, {
    publicDir: AGENT_PUBLIC_DIR,
    resolveVideoSource: (clip) => {
      const proxy = findReusableTranscode(clip.videoId, previewFps, clip.sourceFile);
      if (proxy) proxyCount++;
      return proxy ?? clip.sourceFile;
    },
  });
  return { publicDir, proxyCount };
}
