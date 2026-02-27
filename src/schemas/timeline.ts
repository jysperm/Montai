import { z } from 'zod';

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
