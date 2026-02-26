import { z } from 'zod';

export const StorylineClipSchema = z.object({
  videoId: z.number(),
  startTime: z.string(),
  endTime: z.string(),
  purpose: z.string(),
  narration: z.string().optional(),
});

export const StorylineSchema = z.object({
  title: z.string(),
  description: z.string(),
  style: z.string(),
  acts: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      clips: z.array(StorylineClipSchema),
    })
  ),
  estimatedDurationSeconds: z.number(),
});

export type StorylineClip = z.infer<typeof StorylineClipSchema>;
export type Storyline = z.infer<typeof StorylineSchema>;
