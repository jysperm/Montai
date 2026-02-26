import { z } from 'zod';

export const VideoSegmentSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  mood: z.string(),
  quality: z.enum(['high', 'medium', 'low']),
  hasSpeech: z.boolean(),
  speechContent: z.string().optional(),
});

export const VideoSummarySchema = z.object({
  overview: z.string(),
  location: z.string().optional(),
  timeOfDay: z.string().optional(),
  mainSubjects: z.array(z.string()),
  segments: z.array(VideoSegmentSchema),
  highlights: z.array(
    z.object({
      startTime: z.string(),
      endTime: z.string(),
      reason: z.string(),
    })
  ),
  technicalNotes: z.string().optional(),
});

export type VideoSegment = z.infer<typeof VideoSegmentSchema>;
export type VideoSummary = z.infer<typeof VideoSummarySchema>;
