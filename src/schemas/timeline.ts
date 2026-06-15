import { z } from 'zod';

export const CropSchema = z.object({
  left: z.number().default(0),
  top: z.number().default(0),
  right: z.number().default(0),
  bottom: z.number().default(0),
});

export const TransitionSchema = z.object({
  type: z.enum(['fade', 'slide', 'wipe']),
  durationSeconds: z.number(),
  direction: z.enum(['from-left', 'from-right', 'from-top', 'from-bottom']).optional(),
});

export const ExpandedClipSchema = z.object({
  clipId: z.string(),
  videoId: z.number(),
  sourceFile: z.string(),
  sourceWidth: z.number().optional(),
  sourceHeight: z.number().optional(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
  playbackRate: z.number().default(1),
  volume: z.number().default(1),
  // Spatial conform: how the source fits the sequence frame.
  // Auto-decided by sequence shape in expandTimeline (landscape → contain, vertical/square → cover).
  fit: z.enum(['contain', 'cover']).default('cover'),
  transition: TransitionSchema.optional().catch(undefined),
  rotation: z.number().refine(Number.isFinite).optional().catch(undefined),
  crop: CropSchema.optional().catch(undefined),
  cropEnd: CropSchema.optional().catch(undefined),
});

export const OverlayAnimationSchema = z.object({
  type: z.enum(['fade', 'slide', 'pop']),
  durationSeconds: z.number(),
});

export const ExpandedOverlaySchema = z.object({
  text: z.string(),
  timelineStartSeconds: z.number(),
  timelineEndSeconds: z.number(),
  position: z.enum(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']),
  style: z.enum(['title', 'subtitle', 'caption']),
  animation: OverlayAnimationSchema.optional(),
});

export const ExpandedAudioSchema = z.object({
  sourceFile: z.string(),
  timelineStartSeconds: z.number(),
  timelineEndSeconds: z.number(),
  audioStartSeconds: z.number(),
  volume: z.number(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
});

export const ExpandedVoiceoverSchema = z.object({
  sourceFile: z.string(),
  timelineStartSeconds: z.number(),
  timelineEndSeconds: z.number(),
  audioStartSeconds: z.number(),
  volume: z.number(),
});

// ExpandedClip startTimeSeconds/endTimeSeconds describe source file ranges.
// Expanded overlay/audio/voiceover timelineStartSeconds/timelineEndSeconds describe
// absolute positions in the "overlap model": transitions shorten the timeline by
// overlapping adjacent clips. For example, two 10s clips with a 0.5s transition
// produce a 19.5s timeline. The FCPXML exporter converts these to a "sequential
// model" (clips end-to-end, transitions are visual effects) via overlapToSeq().
export const ExpandedTimelineSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  clips: z.array(ExpandedClipSchema),
  textOverlays: z.array(ExpandedOverlaySchema).default([]),
  audioTracks: z.array(ExpandedAudioSchema).default([]),
  voiceoverTracks: z.array(ExpandedVoiceoverSchema).default([]),
});

export type Crop = z.infer<typeof CropSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type ExpandedClip = z.infer<typeof ExpandedClipSchema>;
export type ExpandedOverlay = z.infer<typeof ExpandedOverlaySchema>;
export type ExpandedAudio = z.infer<typeof ExpandedAudioSchema>;
export type ExpandedVoiceover = z.infer<typeof ExpandedVoiceoverSchema>;
export type ExpandedTimeline = z.infer<typeof ExpandedTimelineSchema>;
