import { z } from 'zod';

export const ProjectSummarySchema = z.object({
  title: z.string(),
  overallTheme: z.string(),
  locations: z.array(z.string()),
  timeline: z.array(
    z.object({
      timeRange: z.string(),
      description: z.string(),
      videoIds: z.array(z.number()),
    })
  ),
  keyMoments: z.array(
    z.object({
      videoId: z.number(),
      startTime: z.string(),
      endTime: z.string(),
      description: z.string(),
      significance: z.string(),
    })
  ),
  suggestedNarratives: z.array(z.string()),
  totalVideos: z.number(),
  totalDurationSeconds: z.number(),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
