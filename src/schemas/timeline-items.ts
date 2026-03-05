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
  transition: TransitionSchema.default({ type: 'none', durationSeconds: 0 }),
});

export const OverlayItemSchema = z.object({
  type: z.literal('overlay'),
  text: z.string(),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  endClip: z.number().int().min(0).optional(),
  endOffset: z.number().default(0),
  position: z.enum(['top', 'center', 'bottom']),
  style: z.enum(['title', 'subtitle', 'caption']),
});

export const AudioItemSchema = z.object({
  type: z.literal('audio'),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  endClip: z.number().int().min(0).optional(),
  endOffset: z.number().default(0),
  sourceFile: z.string().optional(),
  description: z.string().optional(),
  volume: z.number().default(1),
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
): ExpandedTimeline {
  const res = resolveResolution(config.output.resolution);

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
    if (i > 0 && clip.transition.type !== 'none') {
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

      if (startClipIdx >= clipItems.length || endClipIdx >= clipItems.length) {
        console.warn(`Warning: overlay "${overlay.text}" references invalid clip index (startClip=${startClipIdx}, endClip=${endClipIdx}, total clips=${clipItems.length}), skipping`);
        return null;
      }

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
      if (overlay.endOffset <= 0) {
        // 0 or negative = from end of endClip
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
    })
    .filter((o): o is NonNullable<typeof o> => o !== null);

  return {
    name: storyName,
    fps: config.output.fps,
    width: res.width,
    height: res.height,
    clips: timelineClips,
    textOverlays,
  };
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
