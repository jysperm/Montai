import { z } from 'zod';
import type { ProjectConfig } from './project.js';
import { resolveResolution } from './project.js';

export const TransitionSchema = z.object({
  type: z.enum(['none', 'fade', 'slide', 'wipe']),
  durationSeconds: z.number(),
  direction: z.enum(['from-left', 'from-right', 'from-top', 'from-bottom']).optional(),
});

export const TimelineClipSchema = z.object({
  clipId: z.string(),
  videoId: z.number(),
  sourceFile: z.string(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  playbackRate: z.number().default(1),
  volume: z.number().default(1),
  transition: TransitionSchema.default({ type: 'none', durationSeconds: 0 }),
});

export const TextOverlaySchema = z.object({
  text: z.string(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  position: z.enum(['top', 'center', 'bottom']),
  style: z.enum(['title', 'subtitle', 'caption']),
});

export const TimelineSchema = z.object({
  name: z.string(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  clips: z.array(TimelineClipSchema),
  textOverlays: z.array(TextOverlaySchema).default([]),
});

export type Transition = z.infer<typeof TransitionSchema>;
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type Timeline = z.infer<typeof TimelineSchema>;

// Lean LLM output types — no derived fields (name, fps, width, height, clipId, sourceFile)

export const LLMTimelineClipSchema = z.object({
  videoId: z.number(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  playbackRate: z.number().default(1),
  volume: z.number().default(1),
  transition: TransitionSchema.default({ type: 'none', durationSeconds: 0 }),
});

export const LLMTimelineSchema = z.object({
  clips: z.array(LLMTimelineClipSchema),
  textOverlays: z.array(TextOverlaySchema).default([]),
});

export type LLMTimelineClip = z.infer<typeof LLMTimelineClipSchema>;
export type LLMTimeline = z.infer<typeof LLMTimelineSchema>;

/**
 * Expand a lean LLM timeline into a full Timeline by filling in derived fields.
 */
export function expandTimeline(
  input: LLMTimeline,
  config: ProjectConfig,
  storyline: { codename: string },
  videos: { id: number; path: string }[],
): Timeline {
  const res = resolveResolution(config.output.resolution);

  return {
    name: storyline.codename,
    fps: config.output.fps,
    width: res.width,
    height: res.height,
    clips: input.clips.map((clip, index) => {
      const video = videos.find((v) => v.id === clip.videoId);
      return {
        ...clip,
        clipId: `clip-${String(index + 1).padStart(3, '0')}`,
        sourceFile: video?.path ?? '',
      };
    }),
    textOverlays: input.textOverlays,
  };
}
