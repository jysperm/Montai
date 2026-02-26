import { z } from 'zod';

export const TransitionSchema = z.object({
  type: z.enum(['none', 'fade', 'slide', 'wipe']),
  durationSeconds: z.number(),
  direction: z.enum(['from-left', 'from-right', 'from-top', 'from-bottom']).optional(),
});

export const EditClipSchema = z.object({
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

export const EditSpecSchema = z.object({
  name: z.string(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  clips: z.array(EditClipSchema),
  textOverlays: z.array(TextOverlaySchema).default([]),
  titleCard: z
    .object({
      text: z.string(),
      subtitle: z.string().optional(),
      durationSeconds: z.number(),
    })
    .optional(),
  endCard: z
    .object({
      text: z.string(),
      durationSeconds: z.number(),
    })
    .optional(),
});

export type Transition = z.infer<typeof TransitionSchema>;
export type EditClip = z.infer<typeof EditClipSchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type EditSpec = z.infer<typeof EditSpecSchema>;
