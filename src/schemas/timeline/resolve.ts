import type { ProjectConfig } from '../project.js';
import { resolveResolution, sequenceShape } from '../project.js';
import { secondsToTimestamp } from '../../utils/time.js';
import { sourceFileStartSeconds, sourceFileEndSeconds, computeClipTimings, clipAnchoredStart, clipAnchoredEnd, type ClipTimings } from './clip-utils.js';
import type { TimelineItem, ClipItem, OverlayItem, MusicItem, VoiceoverItem, ResolvedAudio, ResolvedTimeline } from '../timeline.js';

const LOOP_CROSSFADE = 1; // seconds of crossfade at loop boundaries

/**
 * Sanitize and expand raw TimelineItems into ResolvedTimeline format.
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
export function resolveTimeline(
  items: TimelineItem[],
  config: ProjectConfig,
  storyName: string,
  videos: { id: number; path: string; width?: number | null; height?: number | null }[],
  storyTitle?: string,
  musicFiles?: { id: number; path: string; durationSeconds?: number | null }[],
  voiceoverFiles?: { id: number; path: string; durationSeconds?: number | null }[],
): { timeline: ResolvedTimeline; sanitizedItems: TimelineItem[]; corrections: string[]; errors: string[] } {
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

  const clipItems = items.filter((item): item is ClipItem => item.type === 'clip');
  const timings = computeClipTimings(clipItems);
  const { startTimes: clipStartTimes, durations: clipDurations } = timings;

  // Spatial conform default: landscape sequences pillarbox cross-oriented sources
  // (contain); vertical / square sequences zoom-fill (cover) to match short-form
  // platform norms.
  const seqShape = sequenceShape(res.width, res.height);
  const defaultFit: 'contain' | 'cover' = seqShape === 'landscape' ? 'contain' : 'cover';

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

  const textOverlays = items
    .filter((item): item is OverlayItem => item.type === 'overlay')
    .map((overlay) => {
      const endClipIdx = overlay.endClip ?? overlay.startClip;
      const startTime = clipAnchoredStart(timings, overlay.startClip, overlay.startOffset);
      // endOffset 0 ends before the outgoing transition (next clip's incoming transition)
      const endTime = clipAnchoredEnd(timings, endClipIdx, overlay.endOffset, clipItems);

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

  const audioTracks = buildAudioTracks(
    items.filter((item): item is MusicItem => item.type === 'music'),
    timings,
    musicFiles,
    corrections,
  );

  // Build voiceover tracks from voiceover items
  const voiceoverTracks = items
    .filter((item): item is VoiceoverItem => item.type === 'voiceover')
    .map((vo) => {
      const startTime = clipAnchoredStart(timings, vo.startClip, vo.startOffset);
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
      if (endTime > timings.total + 0.1) {
        errors.push(
          `Voiceover item (voiceoverId=${vo.voiceoverId}, startClip=${vo.startClip}): voiceover ends at ${endTime.toFixed(1)}s (voiceover start ${Math.max(0, startTime).toFixed(1)}s + audio ${audioDuration.toFixed(1)}s) but total timeline is only ${timings.total.toFixed(1)}s — extend clip durations or add more clips`,
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
      const gapEnd = i + 1 < sortedVo.length ? sortedVo[i + 1].timelineStartSeconds : timings.total;
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

  const timeline: ResolvedTimeline = {
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

// Expand music items into resolved audio tracks, auto-looping with crossfade when a
// track is shorter than its timeline span. Appends a correction per looped item.
function buildAudioTracks(
  musicItems: MusicItem[],
  timings: ClipTimings,
  musicFiles: { id: number; path: string; durationSeconds?: number | null }[] | undefined,
  corrections: string[],
): ResolvedAudio[] {
  return musicItems.flatMap((audio) => {
    const startTime = clipAnchoredStart(timings, audio.startClip, audio.startOffset);
    const endTime = clipAnchoredEnd(timings, audio.endClip ?? audio.startClip, audio.endOffset);

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

    const entries: ResolvedAudio[] = [];

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

    if (entries.length > 1) {
      corrections.push(
        `Music item (musicId=${audio.musicId}): music (${secondsToTimestamp(availableDuration)} available) auto-looped ${entries.length}× with ${LOOP_CROSSFADE}s crossfade to cover ~${Math.round(timelineDuration)}s span`,
      );
    }

    return entries;
  });
}
