import { z } from 'zod';

export const TransitionSchema = z.object({
  type: z.enum(['none', 'fade', 'slide', 'wipe']),
  durationSeconds: z.number(),
  direction: z.enum(['from-left', 'from-right', 'from-top', 'from-bottom']).optional(),
});

export const ExpandedClipSchema = z.object({
  clipId: z.string(),
  videoId: z.number(),
  sourceFile: z.string(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  playbackRate: z.number().default(1),
  volume: z.number().default(1),
  transition: TransitionSchema.default({ type: 'none', durationSeconds: 0 }),
});

export const ExpandedOverlaySchema = z.object({
  text: z.string(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  position: z.enum(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']),
  style: z.enum(['title', 'subtitle', 'caption']),
});

export const ExpandedTimelineSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  clips: z.array(ExpandedClipSchema),
  textOverlays: z.array(ExpandedOverlaySchema).default([]),
});

export type Transition = z.infer<typeof TransitionSchema>;
export type ExpandedClip = z.infer<typeof ExpandedClipSchema>;
export type ExpandedOverlay = z.infer<typeof ExpandedOverlaySchema>;
export type ExpandedTimeline = z.infer<typeof ExpandedTimelineSchema>;
