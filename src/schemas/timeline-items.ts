import chalk from 'chalk';
import { z } from 'zod';
import type { ProjectConfig } from './project.js';
import { resolveResolution, sequenceShape } from './project.js';
import { TransitionSchema, CropSchema, type ExpandedTimeline } from './timeline.js';
import { TIMESTAMP_PATTERN, parseTimestamp, secondsToTimestamp } from '../utils/time.js';

const TimestampSchema = z.string().regex(TIMESTAMP_PATTERN, 'must be MM:SS or MM:SS.s');

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

export type ClipItem = z.infer<typeof ClipItemSchema>;
export type OverlayItem = z.infer<typeof OverlayItemSchema>;
export type MusicItem = z.infer<typeof MusicItemSchema>;
export type VoiceoverItem = z.infer<typeof VoiceoverItemSchema>;
export type TimelineItem = ClipItem | OverlayItem | MusicItem | VoiceoverItem;

export function sourceFileStartSeconds(item: { startTime?: string; startTimeSeconds?: number; audioStartSeconds?: number }): number {
  if (item.startTime != null) return parseTimestamp(item.startTime);
  if (typeof item.startTimeSeconds === 'number') return item.startTimeSeconds;
  if (typeof item.audioStartSeconds === 'number') return item.audioStartSeconds;
  throw new Error('startTime is required');
}

export function sourceFileEndSeconds(item: { endTime?: string; endTimeSeconds?: number; audioEndSeconds?: number }): number {
  if (item.endTime != null) return parseTimestamp(item.endTime);
  if (typeof item.endTimeSeconds === 'number') return item.endTimeSeconds;
  if (typeof item.audioEndSeconds === 'number') return item.audioEndSeconds;
  throw new Error('endTime is required');
}

/**
 * Strip fields that match their Zod-schema default values from timeline items.
 * Used when serializing for DB storage and LLM context to reduce noise.
 */
const defaultsMap: Record<string, Record<string, unknown>> = {
  clip: schemaDefaults(ClipItemObjectSchema),
  overlay: schemaDefaults(OverlayItemSchema),
  music: schemaDefaults(MusicItemObjectSchema),
  voiceover: schemaDefaults(VoiceoverItemObjectSchema),
};

export function stripTimelineDefaults(items: TimelineItem[]): Record<string, unknown>[] {
  return items.map((item) => {
    const defaults = defaultsMap[item.type] ?? {};
    const obj: Record<string, unknown> = { ...item };
    for (const [key, defaultVal] of Object.entries(defaults)) {
      if (obj[key] === defaultVal) delete obj[key];
    }
    return obj;
  });
}

/**
 * Build template data for the timeline-summary prompt.
 * Computes absolute timeline positions from raw items (clip anchors → seconds).
 * Callers render with: renderPrompt('computed-timeline', buildComputedTimelineData(items))
 */
export function buildComputedTimelineData(items: TimelineItem[]): Record<string, unknown> {
  const clipItems = items.filter((i): i is ClipItem => i.type === 'clip');

  // Compute clip timeline positions (same logic as expandTimeline)
  const clipStartTimes: number[] = [];
  const clipDurations: number[] = [];
  let ct = 0;
  for (let i = 0; i < clipItems.length; i++) {
    const clip = clipItems[i];
    const dur = (sourceFileEndSeconds(clip) - sourceFileStartSeconds(clip)) / clip.playbackRate;
    if (i > 0 && clip.transition) ct -= clip.transition.durationSeconds;
    clipStartTimes.push(ct);
    clipDurations.push(dur);
    ct += dur;
  }
  const totalDuration = ct;

  function fmt(n: number) { return (Math.round(n * 10) / 10).toFixed(1); }

  function resolveStart(startClip: number, startOffset: number): number {
    if (startOffset >= 0) return clipStartTimes[startClip] + startOffset;
    return clipStartTimes[startClip] + clipDurations[startClip] + startOffset;
  }

  const clips = clipItems.map((clip, i) => ({
    index: i,
    videoId: clip.videoId,
    timelineStart: fmt(clipStartTimes[i]),
    timelineEnd: fmt(clipStartTimes[i] + clipDurations[i]),
  }));

  const voiceovers = items
    .filter((i): i is VoiceoverItem => i.type === 'voiceover')
    .map((vo) => {
      const start = Math.max(0, resolveStart(vo.startClip, vo.startOffset));
      const duration = sourceFileEndSeconds(vo) - sourceFileStartSeconds(vo);
      return {
        voiceoverId: vo.voiceoverId,
        timelineStart: fmt(start),
        timelineEnd: fmt(start + duration),
        duration: fmt(duration),
      };
    });

  const overlays = items
    .filter((i): i is OverlayItem => i.type === 'overlay')
    .map((o) => {
      const start = Math.max(0, resolveStart(o.startClip, o.startOffset));
      const endClipIdx = o.endClip ?? o.startClip;
      let end: number;
      if (o.endOffset === 0) {
        const nextTrans = clipItems[endClipIdx + 1]?.transition?.durationSeconds ?? 0;
        end = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] - nextTrans;
      } else if (o.endOffset < 0) {
        end = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] + o.endOffset;
      } else {
        end = clipStartTimes[endClipIdx] + o.endOffset;
      }
      const plainText = o.text.replace(/\n/g, ' ');
      return {
        text: plainText.length > 10 ? plainText.slice(0, 10) + '...' : plainText,
        timelineStart: fmt(start),
        timelineEnd: fmt(end),
        duration: fmt(end - start),
      };
    });

  const music = items
    .filter((i): i is MusicItem => i.type === 'music')
    .map((m) => {
      const start = Math.max(0, resolveStart(m.startClip, m.startOffset));
      const endClipIdx = m.endClip ?? m.startClip;
      let end: number;
      if (m.endOffset === 0) {
        end = clipStartTimes[endClipIdx] + clipDurations[endClipIdx];
      } else if (m.endOffset < 0) {
        end = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] + m.endOffset;
      } else {
        end = clipStartTimes[endClipIdx] + m.endOffset;
      }
      return {
        musicId: m.musicId,
        timelineStart: fmt(start),
        timelineEnd: fmt(end),
        duration: fmt(end - start),
        startTime: m.startTime,
        endTime: secondsToTimestamp(sourceFileStartSeconds(m) + (end - start)),
      };
    });

  return { totalDuration: fmt(totalDuration), clips, voiceovers, overlays, music };
}

/**
 * Sanitize and expand raw TimelineItems into ExpandedTimeline format.
 *
 * Sanitization: removes items referencing missing videos/music, clamps out-of-range
 * startClip/endClip, fixes escaped newlines in overlay text.
 *
 * Expansion: resolves clip-anchored positions to absolute times, auto-loops short music
 * with crossfade.
 *
 * Returns:
 * - `timeline`: the expanded result for downstream consumption (Remotion/FCPXML)
 * - `sanitizedItems`: the raw items after sanitization (for writing back to DB in updateTimeline)
 * - `corrections`: human-readable list of all fixes applied (for LLM feedback or console logging)
 *
 * Callers decide what to do with each:
 * - updateTimeline tool: writes sanitizedItems to DB, returns corrections to the LLM
 * - render/export commands: uses timeline for output, logs corrections to console
 */
export function expandTimeline(
  items: TimelineItem[],
  config: ProjectConfig,
  storyName: string,
  videos: { id: number; path: string; width?: number | null; height?: number | null }[],
  storyTitle?: string,
  musicFiles?: { id: number; path: string; durationSeconds?: number | null }[],
  voiceoverFiles?: { id: number; path: string; durationSeconds?: number | null }[],
): { timeline: ExpandedTimeline; sanitizedItems: TimelineItem[]; corrections: string[]; errors: string[] } {
  const res = resolveResolution(config.output.resolution);
  const corrections: string[] = [];
  const errors: string[] = [];

  // --- Sanitize: remove invalid references, clamp indices, fix text ---
  const videoIds = new Set(videos.map((v) => v.id));
  const musicIds = musicFiles ? new Set(musicFiles.map((m) => m.id)) : null;
  const voiceoverIds = voiceoverFiles ? new Set(voiceoverFiles.map((v) => v.id)) : null;

  items = items.filter((item) => {
    if (item.type === 'clip' && !videoIds.has(item.videoId)) {
      corrections.push(`Clip (videoId=${item.videoId}): video not found in database — removed`);
      return false;
    }
    if (item.type === 'music' && musicIds && !musicIds.has(item.musicId)) {
      corrections.push(`Music item (musicId=${item.musicId}): music not found in database — removed`);
      return false;
    }
    if (item.type === 'voiceover' && voiceoverIds && !voiceoverIds.has(item.voiceoverId)) {
      corrections.push(`Voiceover item (voiceoverId=${item.voiceoverId}): voiceover not found in database — removed`);
      return false;
    }
    return true;
  });

  const clipCount = items.filter((i) => i.type === 'clip').length;
  const maxClipIndex = clipCount - 1;

  for (const item of items) {
    if (item.type === 'overlay' || item.type === 'music' || item.type === 'voiceover') {
      const label = item.type === 'overlay'
        ? `Overlay "${item.text.slice(0, 30)}"`
        : item.type === 'music'
          ? `Music item${item.musicId ? ` (musicId=${item.musicId})` : ''}`
          : `Voiceover item (voiceoverId=${item.voiceoverId})`;

      if (item.startClip > maxClipIndex) {
        corrections.push(`${label}: startClip clamped from ${item.startClip} to ${maxClipIndex} (total clips: ${clipCount})`);
        item.startClip = maxClipIndex;
      }
      if ('endClip' in item && item.endClip !== undefined && item.endClip > maxClipIndex) {
        corrections.push(`${label}: endClip clamped from ${item.endClip} to ${maxClipIndex} (total clips: ${clipCount})`);
        item.endClip = maxClipIndex;
      }
    }
    if (item.type === 'overlay' && item.text.includes('\\n')) {
      corrections.push(`Overlay "${item.text.slice(0, 30)}": escaped \\\\n replaced with newline`);
      item.text = item.text.replace(/\\n/g, '\n');
    }
    if (item.type === 'music' && musicFiles) {
      const musicFile = musicFiles.find((m) => m.id === item.musicId);
      const musicDuration = musicFile?.durationSeconds;
      const itemStartSeconds = sourceFileStartSeconds(item);
      if (musicDuration && itemStartSeconds >= musicDuration) {
        const normalized = itemStartSeconds % musicDuration;
        corrections.push(
          `Music item (musicId=${item.musicId}): startTime ${item.startTime} exceeds music duration ${secondsToTimestamp(musicDuration)} - set to ${secondsToTimestamp(normalized)}`,
        );
        item.startTime = secondsToTimestamp(normalized);
      }
    }
  }

  for (const item of items) {
    if (item.type === 'clip') {
      const startSeconds = sourceFileStartSeconds(item);
      const endSeconds = sourceFileEndSeconds(item);
      if (endSeconds <= startSeconds) {
        errors.push(`Clip (videoId=${item.videoId}): endTime (${item.endTime}) must be greater than startTime (${item.startTime})`);
      }
    } else if (item.type === 'voiceover') {
      const startSeconds = sourceFileStartSeconds(item);
      const endSeconds = sourceFileEndSeconds(item);
      if (endSeconds <= startSeconds) {
        errors.push(`Voiceover item (voiceoverId=${item.voiceoverId}): endTime (${item.endTime}) must be greater than startTime (${item.startTime})`);
      }
    }
  }

  // Snapshot sanitized items before expansion mutates anything further
  const sanitizedItems = items.map((i) => ({ ...i })) as TimelineItem[];

  // --- Expand ---

  // Extract clip items in order
  const clipItems = items.filter((item): item is ClipItem => item.type === 'clip');

  // Compute cumulative clip start times in the "overlap model": each transition
  // shortens the timeline by overlapping adjacent clips, so currentTime goes backward
  // by the transition duration before advancing by the next clip's duration.
  const clipStartTimes: number[] = [];
  const clipDurations: number[] = [];
  let currentTime = 0;

  for (let i = 0; i < clipItems.length; i++) {
    const clip = clipItems[i];
    const rawDuration = sourceFileEndSeconds(clip) - sourceFileStartSeconds(clip);
    const effectiveDuration = rawDuration / clip.playbackRate;

    // Subtract transition overlap from previous clip
    if (i > 0 && clip.transition) {
      currentTime -= clip.transition.durationSeconds;
    }

    clipStartTimes.push(currentTime);
    clipDurations.push(effectiveDuration);
    currentTime += effectiveDuration;
  }

  // Spatial conform default: landscape sequences pillarbox cross-oriented sources
  // (contain); vertical / square sequences zoom-fill (cover) to match short-form
  // platform norms.
  const seqShape = sequenceShape(res.width, res.height);
  const defaultFit: 'contain' | 'cover' = seqShape === 'landscape' ? 'contain' : 'cover';

  // Build clips array
  const timelineClips = clipItems.map((clip, index) => {
    const video = videos.find((v) => v.id === clip.videoId);
    return {
      clipId: `clip-${String(index + 1).padStart(3, '0')}`,
      videoId: clip.videoId,
      sourceFile: video?.path ?? '',
      sourceWidth: video?.width ?? undefined,
      sourceHeight: video?.height ?? undefined,
      startTimeSeconds: sourceFileStartSeconds(clip),
      endTimeSeconds: sourceFileEndSeconds(clip),
      playbackRate: clip.playbackRate,
      volume: clip.volume,
      fit: defaultFit,
      transition: clip.transition,
      rotation: clip.rotation,
      crop: clip.crop,
      cropEnd: clip.cropEnd,
    };
  });

  // Build text overlays from overlay items
  const textOverlays = items
    .filter((item): item is OverlayItem => item.type === 'overlay')
    .map((overlay) => {
      const startClipIdx = overlay.startClip;
      const endClipIdx = overlay.endClip ?? overlay.startClip;

      // Resolve start time
      let startTime: number;
      if (overlay.startOffset >= 0) {
        startTime = clipStartTimes[startClipIdx] + overlay.startOffset;
      } else {
        // Negative offset = from clip end
        startTime = clipStartTimes[startClipIdx] + clipDurations[startClipIdx] + overlay.startOffset;
      }

      // Resolve end time
      let endTime: number;
      if (overlay.endOffset === 0) {
        // Default: end before the outgoing transition (next clip's incoming transition)
        const nextClip = clipItems[endClipIdx + 1];
        const transDur = nextClip?.transition
          ? nextClip.transition.durationSeconds : 0;
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] - transDur;
      } else if (overlay.endOffset < 0) {
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] + overlay.endOffset;
      } else {
        endTime = clipStartTimes[endClipIdx] + overlay.endOffset;
      }

      return {
        text: overlay.text,
        timelineStartSeconds: Math.max(0, startTime),
        timelineEndSeconds: endTime,
        position: overlay.position,
        style: overlay.style,
        animation: overlay.animation && overlay.animation !== 'none'
          ? { type: overlay.animation, durationSeconds: 0.3 }
          : undefined,
      };
    });

  // Build audio tracks from music items, with auto-loop when music is too short
  const LOOP_CROSSFADE = 1; // seconds of crossfade at loop boundaries
  const audioTracks = items
    .filter((item): item is MusicItem => item.type === 'music')
    .flatMap((audio) => {
      const startClipIdx = audio.startClip;
      const endClipIdx = audio.endClip ?? audio.startClip;

      // Resolve start/end times (same logic as overlays)
      let startTime: number;
      if (audio.startOffset >= 0) {
        startTime = clipStartTimes[startClipIdx] + audio.startOffset;
      } else {
        startTime = clipStartTimes[startClipIdx] + clipDurations[startClipIdx] + audio.startOffset;
      }

      let endTime: number;
      if (audio.endOffset === 0) {
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx];
      } else if (audio.endOffset < 0) {
        endTime = clipStartTimes[endClipIdx] + clipDurations[endClipIdx] + audio.endOffset;
      } else {
        endTime = clipStartTimes[endClipIdx] + audio.endOffset;
      }

      // Resolve source file from musicId (missing refs already filtered by sanitize)
      let sourceFile = '';
      let musicDuration: number | null = null;
      if (audio.musicId && musicFiles) {
        const musicFile = musicFiles.find((m) => m.id === audio.musicId);
        if (musicFile) {
          sourceFile = musicFile.path;
          musicDuration = musicFile.durationSeconds ?? null;
        }
      }

      const timelineDuration = endTime - Math.max(0, startTime);
      const musicStartSeconds = sourceFileStartSeconds(audio);
      const availableDuration = musicDuration != null
        ? musicDuration - musicStartSeconds
        : Infinity;

      // No looping needed: single entry
      if (availableDuration >= timelineDuration) {
        return [{
          sourceFile,
          timelineStartSeconds: Math.max(0, startTime),
          timelineEndSeconds: endTime,
          audioStartSeconds: musicStartSeconds,
          volume: audio.volume,
          fadeInSeconds: audio.fadeInSeconds,
          fadeOutSeconds: audio.fadeOutSeconds,
        }];
      }

      // Auto-loop: split into multiple entries with crossfade at boundaries
      // Safety: if available duration is too small, return a single truncated entry
      if (availableDuration <= LOOP_CROSSFADE) {
        return [{
          sourceFile,
          timelineStartSeconds: Math.max(0, startTime),
          timelineEndSeconds: Math.max(0, startTime) + Math.max(0, availableDuration),
          audioStartSeconds: musicStartSeconds,
          volume: audio.volume,
          fadeInSeconds: audio.fadeInSeconds,
          fadeOutSeconds: audio.fadeOutSeconds,
        }];
      }

      const entries: {
        sourceFile: string;
        timelineStartSeconds: number;
        timelineEndSeconds: number;
        audioStartSeconds: number;
        volume: number;
        fadeInSeconds: number;
        fadeOutSeconds: number;
      }[] = [];

      let currentTime = Math.max(0, startTime);
      let isFirst = true;

      while (currentTime < endTime) {
        const audioStart = isFirst ? musicStartSeconds : 0;
        const segmentAvailable = musicDuration! - audioStart;
        const segmentEnd = Math.min(currentTime + segmentAvailable, endTime);

        // If remaining gap after this segment is too small for another loop iteration,
        // extend this segment to cover the rest
        const nextTime = segmentEnd - LOOP_CROSSFADE;
        const remainingAfter = endTime - nextTime;
        const isLast = segmentEnd >= endTime || remainingAfter <= LOOP_CROSSFADE;
        const actualEnd = isLast ? endTime : segmentEnd;

        entries.push({
          sourceFile,
          timelineStartSeconds: currentTime,
          timelineEndSeconds: actualEnd,
          audioStartSeconds: audioStart,
          volume: audio.volume,
          fadeInSeconds: isFirst ? audio.fadeInSeconds : LOOP_CROSSFADE,
          fadeOutSeconds: isLast ? audio.fadeOutSeconds : LOOP_CROSSFADE,
        });

        if (isLast) break;

        // Advance past this segment, overlapping by crossfade duration
        currentTime = segmentEnd - LOOP_CROSSFADE;
        isFirst = false;
      }

      const loopCount = entries.length;
      if (loopCount > 1) {
        corrections.push(
          `Music item (musicId=${audio.musicId}): music (${secondsToTimestamp(availableDuration)} available) auto-looped ${loopCount}× with ${LOOP_CROSSFADE}s crossfade to cover ~${Math.round(timelineDuration)}s span`,
        );
      }

      return entries;
    });

  // Build voiceover tracks from voiceover items
  const voiceoverTracks = items
    .filter((item): item is VoiceoverItem => item.type === 'voiceover')
    .map((vo) => {
      const startClipIdx = vo.startClip;

      // Resolve start time
      let startTime: number;
      if (vo.startOffset >= 0) {
        startTime = clipStartTimes[startClipIdx] + vo.startOffset;
      } else {
        startTime = clipStartTimes[startClipIdx] + clipDurations[startClipIdx] + vo.startOffset;
      }

      const voiceoverStartSeconds = sourceFileStartSeconds(vo);
      const voiceoverEndSeconds = sourceFileEndSeconds(vo);
      const audioDuration = voiceoverEndSeconds - voiceoverStartSeconds;
      const endTime = Math.max(0, startTime) + audioDuration;

      // Resolve source file and validate audio range
      let sourceFile = '';
      let recordingDuration: number | null = null;
      if (vo.voiceoverId && voiceoverFiles) {
        const voFile = voiceoverFiles.find((v) => v.id === vo.voiceoverId);
        if (voFile) {
          sourceFile = voFile.path;
          recordingDuration = voFile.durationSeconds ?? null;
        }
      }

      if (recordingDuration != null && voiceoverEndSeconds > recordingDuration) {
        errors.push(
          `Voiceover item (voiceoverId=${vo.voiceoverId}): endTime (${vo.endTime}) exceeds recording duration (${secondsToTimestamp(recordingDuration)})`,
        );
      }

      // Validation: check if voiceover extends beyond the timeline end
      const totalTimelineDuration = clipItems.length > 0
        ? clipStartTimes[clipItems.length - 1] + clipDurations[clipItems.length - 1]
        : 0;
      if (endTime > totalTimelineDuration + 0.1) {
        errors.push(
          `Voiceover item (voiceoverId=${vo.voiceoverId}, startClip=${vo.startClip}): voiceover ends at ${endTime.toFixed(1)}s (voiceover start ${Math.max(0, startTime).toFixed(1)}s + audio ${audioDuration.toFixed(1)}s) but total timeline is only ${totalTimelineDuration.toFixed(1)}s — extend clip durations or add more clips`,
        );
      }

      return {
        sourceFile,
        timelineStartSeconds: Math.max(0, startTime),
        timelineEndSeconds: endTime,
        audioStartSeconds: voiceoverStartSeconds,
        volume: vo.volume,
      };
    });

  // Warn about silent gaps between voiceover segments not covered by music
  if (voiceoverTracks.length > 0) {
    const sortedVo = [...voiceoverTracks].sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds);
    const totalTimelineDuration = clipItems.length > 0
      ? clipStartTimes[clipItems.length - 1] + clipDurations[clipItems.length - 1]
      : 0;

    // Check gap before the first voiceover
    const firstStart = sortedVo[0].timelineStartSeconds;
    if (firstStart > 0.5) {
      const hasMusicCoverage = audioTracks.some(
        (a) => a.timelineStartSeconds < firstStart && a.timelineEndSeconds > 0,
      );
      if (!hasMusicCoverage) {
        corrections.push(
          `Silent gap (0.0s–${firstStart.toFixed(1)}s): no voiceover or music — consider adding background music`,
        );
      }
    }

    // Check gaps between voiceover segments and after the last one
    for (let i = 0; i < sortedVo.length; i++) {
      const gapStart = sortedVo[i].timelineEndSeconds;
      const gapEnd = i + 1 < sortedVo.length ? sortedVo[i + 1].timelineStartSeconds : totalTimelineDuration;
      if (gapEnd - gapStart < 0.5) continue;

      const hasMusicCoverage = audioTracks.some(
        (a) => a.timelineStartSeconds < gapEnd && a.timelineEndSeconds > gapStart,
      );
      if (!hasMusicCoverage) {
        corrections.push(
          `Silent gap (${gapStart.toFixed(1)}s–${gapEnd.toFixed(1)}s): no voiceover or music — consider adding background music`,
        );
      }
    }
  }

  const timeline: ExpandedTimeline = {
    name: storyName,
    title: storyTitle,
    fps: config.output.fps,
    width: res.width,
    height: res.height,
    clips: timelineClips,
    textOverlays,
    audioTracks,
    voiceoverTracks,
  };

  return { timeline, sanitizedItems, corrections, errors };
}

/**
 * Splice timeline items with automatic clipIndex remapping for overlay/music/voiceover items.
 * Similar to Array.prototype.splice: remove `deleteCount` items starting at `index`,
 * then insert `newItems` at that position. Use deleteCount=-1 to delete all from index.
 */
export function spliceTimelineItems(
  currentItems: TimelineItem[],
  index: number,
  deleteCount: number,
  newItems: TimelineItem[] = [],
): TimelineItem[] {
  const items = [...currentItems];

  // Handle deleteCount=-1 as "delete all from index"
  const effectiveDeleteCount = deleteCount === -1 ? items.length - index : deleteCount;

  // Count clip items in the deleted range
  const deletedSlice = items.slice(index, index + effectiveDeleteCount);
  const deletedClipCount = deletedSlice.filter((i) => i.type === 'clip').length;

  // Count clip items in the new items
  const insertedClipCount = newItems.filter((i) => i.type === 'clip').length;

  // Find the clip index of the first clip at or after `index`
  let clipIndexAtSplicePoint = 0;
  for (let i = 0; i < index && i < items.length; i++) {
    if (items[i].type === 'clip') {
      clipIndexAtSplicePoint++;
    }
  }

  // Perform the splice
  items.splice(index, effectiveDeleteCount, ...newItems);

  // Remap clipIndex references in overlay/music/voiceover items that are outside the spliced range
  const clipDelta = insertedClipCount - deletedClipCount;
  if (clipDelta !== 0) {
    for (const item of items) {
      if (item.type === 'overlay' || item.type === 'music' || item.type === 'voiceover') {
        if (item.startClip >= clipIndexAtSplicePoint + deletedClipCount) {
          item.startClip += clipDelta;
        }
        if ('endClip' in item && item.endClip !== undefined && item.endClip >= clipIndexAtSplicePoint + deletedClipCount) {
          item.endClip += clipDelta;
        }
      }
    }
  }

  return items;
}
