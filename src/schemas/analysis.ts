import { z } from 'zod';
import { TIMESTAMP_PATTERN } from '../utils/time.js';

const TimestampSchema = z.string().regex(TIMESTAMP_PATTERN, 'must be MM:SS or MM:SS.s');

export const VideoSegmentSchema = z.object({
  startTime: TimestampSchema,
  endTime: TimestampSchema,
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
      startTime: TimestampSchema,
      endTime: TimestampSchema,
      reason: z.string(),
    })
  ),
  technicalNotes: z.string().optional(),
});

export const MusicSegmentSchema = z.object({
  startTime: TimestampSchema,
  endTime: TimestampSchema,
  description: z.string(),
});

export const MusicAnalysisSchema = z.object({
  overview: z.string(),
  segments: z.array(MusicSegmentSchema),
});

export const VoiceoverTranscriptionSegmentSchema = z.object({
  startTime: TimestampSchema,
  endTime: TimestampSchema,
  text: z.string(),
  skip: z.boolean(),
});

export const VoiceoverAnalysisSchema = z.object({
  overview: z.string(),
  transcription: z.array(VoiceoverTranscriptionSegmentSchema),
});

export type VideoSegment = z.infer<typeof VideoSegmentSchema>;
export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>;
export type MusicSegment = z.infer<typeof MusicSegmentSchema>;
export type MusicAnalysis = z.infer<typeof MusicAnalysisSchema>;
export type VoiceoverTranscriptionSegment = z.infer<typeof VoiceoverTranscriptionSegmentSchema>;
export type VoiceoverAnalysis = z.infer<typeof VoiceoverAnalysisSchema>;
