import chalk from 'chalk';
import { z } from 'zod';
import type { ProjectConfig } from './project.js';
import { resolveResolution } from './project.js';
import { TransitionSchema, type ExpandedTimeline } from './timeline.js';

export const ClipItemSchema = z.object({
  type: z.literal('clip'),
  videoId: z.number(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  playbackRate: z.number().default(1),
  volume: z.number().default(1),
  transition: TransitionSchema.optional().catch(undefined),
});

export const OverlayItemSchema = z.object({
  type: z.literal('overlay'),
  text: z.string(),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  endClip: z.number().int().min(0).optional(),
  endOffset: z.number().default(0),
  position: z.enum(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']),
  style: z.enum(['title', 'subtitle', 'caption']),
});

export const AudioItemSchema = z.object({
  type: z.literal('audio'),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  endClip: z.number().int().min(0).optional(),
  endOffset: z.number().default(0),
  musicId: z.number().optional(),
  audioStartSeconds: z.number().default(0),
  generationPrompt: z.string().optional(),
  volume: z.number().default(1),
  fadeInSeconds: z.number().default(0),
  fadeOutSeconds: z.number().default(0),
});

export const TimelineItemSchema = z.discriminatedUnion('type', [
  ClipItemSchema,
  OverlayItemSchema,
  AudioItemSchema,
]);

export type ClipItem = z.infer<typeof ClipItemSchema>;
export type OverlayItem = z.infer<typeof OverlayItemSchema>;
export type AudioItem = z.infer<typeof AudioItemSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

/**
 * Expand raw TimelineItems into ExpandedTimeline format for downstream consumption (Remotion/FCPXML).
 */
export function expandTimeline(
  items: TimelineItem[],
  config: ProjectConfig,
  storyName: string,
  videos: { id: number; path: string }[],
  storyTitle?: string,
  musicFiles?: { id: number; path: string; durationSeconds?: number | null }[],
): ExpandedTimeline {
  const res = resolveResolution(config.output.resolution);

  // Sanitize items before expansion
  const { items: sanitizedItems, corrections } = sanitizeTimelineItems(items);
  items = sanitizedItems;
  if (corrections.length > 0) {
    console.log(chalk.yellow(`Timeline "${storyName}" sanitized:\n${corrections.map((c) => `  - ${c}`).join('\n')}`));
  }

  // Extract clip items in order
  const clipItems = items.filter((item): item is ClipItem => item.type === 'clip');

  // Compute cumulative clip start times (accounting for playbackRate and transitions)
  const clipStartTimes: number[] = [];
  const clipDurations: number[] = [];
  let currentTime = 0;

  for (let i = 0; i < clipItems.length; i++) {
    const clip = clipItems[i];
    const rawDuration = clip.endTimeSeconds - clip.startTimeSeconds;
    const effectiveDuration = rawDuration / clip.playbackRate;

    // Subtract transition overlap from previous clip
    if (i > 0 && clip.transition) {
      currentTime -= clip.transition.durationSeconds;
    }

    clipStartTimes.push(currentTime);
    clipDurations.push(effectiveDuration);
    currentTime += effectiveDuration;
  }

  // Build clips array
  const timelineClips = clipItems.map((clip, index) => {
    const video = videos.find((v) => v.id === clip.videoId);
    return {
      clipId: `clip-${String(index + 1).padStart(3, '0')}`,
      videoId: clip.videoId,
      sourceFile: video?.path ?? '',
      startTimeSeconds: clip.startTimeSeconds,
      endTimeSeconds: clip.endTimeSeconds,
      playbackRate: clip.playbackRate,
      volume: clip.volume,
      transition: clip.transition,
    };
  });

  // Build text overlays from overlay items
  const textOverlays = items
    .filter((item): item is OverlayItem => item.type === 'overlay')
    .map((overlay) => {
      const startClipIdx = overlay.startClip;
      const endClipIdx = overlay.endClip ?? overlay.startClip;

      // Resolve start time
      let startTime: number;
      if (overlay.startOffset >= 0) {
        startTime = clipStartTimes[startClipIdx] + overlay.startOffset;
      } else {
        // Negative offset = from clip end
        startTime = clipStartTimes[startClipIdx] + clipDurations[startClipIdx] + overlay.startOffset;
      }

      // Resolve end time
      let endTime: number;
      if (overlay.endOffset === 0) {
        // Default: end before the outgoing transition (next clip's incoming transition)
        const nextClip = clipItems[endClipIdx + 1];
        const transDur = nextClip?.transition
          ? nextClip.transition.durationSeconds : 0;
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] - transDur;
      } else if (overlay.endOffset < 0) {
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] + overlay.endOffset;
      } else {
        endTime = clipStartTimes[endClipIdx] + overlay.endOffset;
      }

      return {
        text: overlay.text,
        startTimeSeconds: Math.max(0, startTime),
        endTimeSeconds: endTime,
        position: overlay.position,
        style: overlay.style,
      };
    });

  // Build audio tracks from audio items
  const audioTracks = items
    .filter((item): item is AudioItem => item.type === 'audio')
    .map((audio) => {
      const startClipIdx = audio.startClip;
      const endClipIdx = audio.endClip ?? audio.startClip;

      // Resolve start/end times (same logic as overlays)
      let startTime: number;
      if (audio.startOffset >= 0) {
        startTime = clipStartTimes[startClipIdx] + audio.startOffset;
      } else {
        startTime = clipStartTimes[startClipIdx] + clipDurations[startClipIdx] + audio.startOffset;
      }

      let endTime: number;
      if (audio.endOffset === 0) {
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx];
      } else if (audio.endOffset < 0) {
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] + audio.endOffset;
      } else {
        endTime = clipStartTimes[endClipIdx] + audio.endOffset;
      }

      // Resolve source file from musicId
      let sourceFile = '';
      if (audio.musicId && musicFiles) {
        const musicFile = musicFiles.find((m) => m.id === audio.musicId);
        if (musicFile) {
          sourceFile = musicFile.path;
          // Warn if music duration is insufficient
          const neededDuration = (endTime - startTime) + audio.audioStartSeconds;
          if (musicFile.durationSeconds && neededDuration > musicFile.durationSeconds) {
            console.log(chalk.yellow(`Warning: music "${musicFile.path}" duration (${musicFile.durationSeconds}s) may be insufficient for audio item (needs ~${Math.round(neededDuration)}s)`));
          }
        }
      }

      return {
        sourceFile,
        startTimeSeconds: Math.max(0, startTime),
        endTimeSeconds: endTime,
        audioStartSeconds: audio.audioStartSeconds,
        volume: audio.volume,
        fadeInSeconds: audio.fadeInSeconds,
        fadeOutSeconds: audio.fadeOutSeconds,
      };
    });

  return {
    name: storyName,
    title: storyTitle,
    fps: config.output.fps,
    width: res.width,
    height: res.height,
    clips: timelineClips,
    textOverlays,
    audioTracks,
  };
}

/**
 * Post-process timeline items: fix common LLM errors and return corrections.
 * Called after splice in updateTimeline, before writing to DB.
 */
export function sanitizeTimelineItems(
  items: TimelineItem[],
): { items: TimelineItem[]; corrections: string[] } {
  const corrections: string[] = [];
  const clipCount = items.filter((i) => i.type === 'clip').length;
  const maxClipIndex = clipCount - 1;

  for (const item of items) {
    if (item.type === 'overlay' || item.type === 'audio') {
      const label = item.type === 'overlay'
        ? `Overlay "${item.text.slice(0, 30)}"`
        : `Audio item${item.musicId ? ` (musicId=${item.musicId})` : ''}`;

      // Clamp startClip
      if (item.startClip > maxClipIndex) {
        corrections.push(`${label}: startClip clamped from ${item.startClip} to ${maxClipIndex} (total clips: ${clipCount})`);
        item.startClip = maxClipIndex;
      }

      // Clamp endClip
      if (item.endClip !== undefined && item.endClip > maxClipIndex) {
        corrections.push(`${label}: endClip clamped from ${item.endClip} to ${maxClipIndex} (total clips: ${clipCount})`);
        item.endClip = maxClipIndex;
      }
    }

    // Fix escaped newlines in overlay text
    if (item.type === 'overlay' && item.text.includes('\\n')) {
      corrections.push(`Overlay "${item.text.slice(0, 30)}": escaped \\\\n replaced with newline`);
      item.text = item.text.replace(/\\n/g, '\n');
    }
  }

  return { items, corrections };
}

/**
 * Splice timeline items with automatic clipIndex remapping for overlay/audio items.
 * Similar to Array.prototype.splice: remove `deleteCount` items starting at `index`,
 * then insert `newItems` at that position. Use deleteCount=-1 to delete all from index.
 */
export function spliceTimelineItems(
  currentItems: TimelineItem[],
  index: number,
  deleteCount: number,
  newItems: TimelineItem[] = [],
): TimelineItem[] {
  const items = [...currentItems];

  // Handle deleteCount=-1 as "delete all from index"
  const effectiveDeleteCount = deleteCount === -1 ? items.length - index : deleteCount;

  // Count clip items in the deleted range
  const deletedSlice = items.slice(index, index + effectiveDeleteCount);
  const deletedClipCount = deletedSlice.filter((i) => i.type === 'clip').length;

  // Count clip items in the new items
  const insertedClipCount = newItems.filter((i) => i.type === 'clip').length;

  // Find the clip index of the first clip at or after `index`
  let clipIndexAtSplicePoint = 0;
  for (let i = 0; i < index && i < items.length; i++) {
    if (items[i].type === 'clip') {
      clipIndexAtSplicePoint++;
    }
  }

  // Perform the splice
  items.splice(index, effectiveDeleteCount, ...newItems);

  // Remap clipIndex references in overlay/audio items that are outside the spliced range
  const clipDelta = insertedClipCount - deletedClipCount;
  if (clipDelta !== 0) {
    for (const item of items) {
      if (item.type === 'overlay' || item.type === 'audio') {
        if (item.startClip >= clipIndexAtSplicePoint + deletedClipCount) {
          item.startClip += clipDelta;
        }
        if (item.endClip !== undefined && item.endClip >= clipIndexAtSplicePoint + deletedClipCount) {
          item.endClip += clipDelta;
        }
      }
    }
  }

  return items;
}
