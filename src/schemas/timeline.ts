import { z } from 'zod';
import { TIMESTAMP_PATTERN, secondsToTimestamp } from '../utils/time.js';

// Two families of types live here. The raw item types (ClipItem/OverlayItem/
// MusicItem/VoiceoverItem) are the editable model the agent authors and we store in
// the DB — clip-anchored, compact. The Resolved* types are the expanded output
// resolveTimeline() produces for Remotion/FCPXML — absolute timeline positions,
// source paths, fps, and resolution filled in.

export type Crop = z.infer<typeof CropSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type ClipItem = z.infer<typeof ClipItemSchema>;
export type OverlayItem = z.infer<typeof OverlayItemSchema>;
export type MusicItem = z.infer<typeof MusicItemSchema>;
export type VoiceoverItem = z.infer<typeof VoiceoverItemSchema>;
export type TimelineItem = ClipItem | OverlayItem | MusicItem | VoiceoverItem;

export type ResolvedClip = z.infer<typeof ResolvedClipSchema>;
export type ResolvedOverlay = z.infer<typeof ResolvedOverlaySchema>;
export type ResolvedAudio = z.infer<typeof ResolvedAudioSchema>;
export type ResolvedVoiceover = z.infer<typeof ResolvedVoiceoverSchema>;
export type ResolvedTimeline = z.infer<typeof ResolvedTimelineSchema>;

const TimestampSchema = z.string().regex(TIMESTAMP_PATTERN, 'must be MM:SS or MM:SS.s');

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

export const OverlayAnimationSchema = z.object({
  type: z.enum(['fade', 'slide', 'pop']),
  durationSeconds: z.number(),
});

const ClipItemObjectSchema = z.object({
  type: z.literal('clip'),
  videoId: z.number(),
  startTime: TimestampSchema,
  endTime: TimestampSchema,
  playbackRate: z.number().default(1),
  volume: z.number().default(1),
  transition: TransitionSchema.optional().catch(undefined),
  // rotation + cropEnd Ken Burns works in Remotion but degrades to static cropEnd in FCPXML export (see src/fcpxml/generate.ts for why).
  rotation: z.number().refine(Number.isFinite).optional().catch(undefined),
  crop: CropSchema.optional().catch(undefined),
  cropEnd: CropSchema.optional().catch(undefined),
});

export const ClipItemSchema = z.preprocess(normalizeLegacyTimelineItem, ClipItemObjectSchema);

export const OverlayItemSchema = z.object({
  type: z.literal('overlay'),
  text: z.string(),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  endClip: z.number().int().min(0).optional(),
  endOffset: z.number().default(0),
  position: z.enum(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']),
  style: z.enum(['title', 'subtitle', 'caption']),
  animation: z.enum(['none', 'fade', 'slide', 'pop']).default('none'),
});

const MusicItemObjectSchema = z.object({
  type: z.literal('music'),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  endClip: z.number().int().min(0).optional(),
  endOffset: z.number().default(0),
  musicId: z.number(),
  startTime: TimestampSchema.default('00:00'),
  volume: z.number().default(1),
  fadeInSeconds: z.number().default(0),
  fadeOutSeconds: z.number().default(0),
});

export const MusicItemSchema = z.preprocess(normalizeLegacyTimelineItem, MusicItemObjectSchema);

const VoiceoverItemObjectSchema = z.object({
  type: z.literal('voiceover'),
  voiceoverId: z.number(),
  startClip: z.number().int().min(0),
  startOffset: z.number().default(0),
  startTime: TimestampSchema,
  endTime: TimestampSchema,
  volume: z.number().default(1),
});

export const VoiceoverItemSchema = z.preprocess(normalizeLegacyTimelineItem, VoiceoverItemObjectSchema);

const TimelineItemObjectSchema = z.discriminatedUnion('type', [
  ClipItemObjectSchema,
  OverlayItemSchema,
  MusicItemObjectSchema,
  VoiceoverItemObjectSchema,
]);

export const TimelineItemSchema = z.preprocess(normalizeLegacyTimelineItem, TimelineItemObjectSchema);

// Per-type field defaults, used by stripTimelineDefaults to drop noise when serializing.
export const defaultsMap: Record<string, Record<string, unknown>> = {
  clip: schemaDefaults(ClipItemObjectSchema),
  overlay: schemaDefaults(OverlayItemSchema),
  music: schemaDefaults(MusicItemObjectSchema),
  voiceover: schemaDefaults(VoiceoverItemObjectSchema),
};

export const ResolvedClipSchema = z.object({
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
  // Auto-decided by sequence shape in resolveTimeline (landscape → contain, vertical/square → cover).
  fit: z.enum(['contain', 'cover']).default('cover'),
  transition: TransitionSchema.optional().catch(undefined),
  rotation: z.number().refine(Number.isFinite).optional().catch(undefined),
  crop: CropSchema.optional().catch(undefined),
  cropEnd: CropSchema.optional().catch(undefined),
});

export const ResolvedOverlaySchema = z.object({
  text: z.string(),
  timelineStartSeconds: z.number(),
  timelineEndSeconds: z.number(),
  position: z.enum(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']),
  style: z.enum(['title', 'subtitle', 'caption']),
  animation: OverlayAnimationSchema.optional(),
});

export const ResolvedAudioSchema = z.object({
  sourceFile: z.string(),
  timelineStartSeconds: z.number(),
  timelineEndSeconds: z.number(),
  audioStartSeconds: z.number(),
  volume: z.number(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
});

export const ResolvedVoiceoverSchema = z.object({
  sourceFile: z.string(),
  timelineStartSeconds: z.number(),
  timelineEndSeconds: z.number(),
  audioStartSeconds: z.number(),
  volume: z.number(),
});

// ResolvedClip startTimeSeconds/endTimeSeconds describe source file ranges.
// Resolved overlay/audio/voiceover timelineStartSeconds/timelineEndSeconds describe
// absolute positions in the "overlap model": transitions shorten the timeline by
// overlapping adjacent clips. For example, two 10s clips with a 0.5s transition
// produce a 19.5s timeline. The FCPXML exporter converts these to a "sequential
// model" (clips end-to-end, transitions are visual effects) via overlapToSeq().
export const ResolvedTimelineSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  clips: z.array(ResolvedClipSchema),
  textOverlays: z.array(ResolvedOverlaySchema).default([]),
  audioTracks: z.array(ResolvedAudioSchema).default([]),
  voiceoverTracks: z.array(ResolvedVoiceoverSchema).default([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function legacySecondsToTimestamp(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? secondsToTimestamp(value)
    : undefined;
}

function normalizeLegacyTimelineItem(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const next = { ...value };
  if (next.type === 'clip') {
    next.startTime ??= legacySecondsToTimestamp(next.startTimeSeconds);
    next.endTime ??= legacySecondsToTimestamp(next.endTimeSeconds);
    delete next.startTimeSeconds;
    delete next.endTimeSeconds;
  } else if (next.type === 'music') {
    next.startTime ??= legacySecondsToTimestamp(next.audioStartSeconds);
    delete next.audioStartSeconds;
  } else if (next.type === 'voiceover') {
    next.startTime ??= legacySecondsToTimestamp(next.audioStartSeconds);
    next.endTime ??= legacySecondsToTimestamp(next.audioEndSeconds);
    delete next.audioStartSeconds;
    delete next.audioEndSeconds;
  }
  return next;
}

function schemaDefaults(schema: z.ZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    if (key === 'type') continue;
    const def = (fieldSchema as z.ZodType)._zod?.def as { type?: string; defaultValue?: unknown } | undefined;
    if (def?.type === 'default') defaults[key] = def.defaultValue;
  }
  return defaults;
}
