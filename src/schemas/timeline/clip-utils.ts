import { parseTimestamp } from '../../utils/time.js';
import type { ClipItem } from '../timeline.js';

export interface ClipTimings {
  startTimes: number[];
  durations: number[];
  total: number;
}

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

// Cumulative clip start times in the "overlap model": each transition shortens the
// timeline by overlapping adjacent clips, so the cursor steps back by the transition
// duration before advancing by the next clip's (playback-rate-adjusted) duration.
export function computeClipTimings(clips: ClipItem[]): ClipTimings {
  const startTimes: number[] = [];
  const durations: number[] = [];
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const duration = (sourceFileEndSeconds(clip) - sourceFileStartSeconds(clip)) / clip.playbackRate;
    if (i > 0 && clip.transition) t -= clip.transition.durationSeconds;
    startTimes.push(t);
    durations.push(duration);
    t += duration;
  }
  return { startTimes, durations, total: t };
}

// Resolve a clip-anchored start position to absolute timeline seconds; negative offset counts back from the clip's end.
export function clipAnchoredStart({ startTimes, durations }: ClipTimings, startClip: number, startOffset: number): number {
  if (startOffset >= 0) return startTimes[startClip] + startOffset;
  return startTimes[startClip] + durations[startClip] + startOffset;
}

// Resolve a clip-anchored end position to absolute timeline seconds. endOffset>0 counts
// from the clip's start, <0 from its end, 0 = the clip's end. Pass `outgoingTransitionClips`
// to make the endOffset-0 case end at the start of the next clip's incoming transition.
export function clipAnchoredEnd(
  { startTimes, durations }: ClipTimings,
  endClip: number,
  endOffset: number,
  outgoingTransitionClips?: ClipItem[],
): number {
  if (endOffset > 0) return startTimes[endClip] + endOffset;
  if (endOffset < 0) return startTimes[endClip] + durations[endClip] + endOffset;
  let end = startTimes[endClip] + durations[endClip];
  if (outgoingTransitionClips) {
    end -= outgoingTransitionClips[endClip + 1]?.transition?.durationSeconds ?? 0;
  }
  return end;
}
