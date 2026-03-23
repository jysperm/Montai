import { z } from 'zod';

export const VideoSegmentSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  description: z.string(),
  qualityNotes: z.string().optional(),
  speechContent: z.string().optional(),
});

export const VideoAnalysisSchema = z.object({
  overview: z.string(),
  location: z.string().optional(),
  timeOfDay: z.string().optional(),
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
export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>;
