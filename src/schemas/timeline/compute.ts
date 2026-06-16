import { secondsToTimestamp } from '../../utils/time.js';
import { sourceFileStartSeconds, sourceFileEndSeconds, computeClipTimings, clipAnchoredStart, clipAnchoredEnd } from './clip-utils.js';
import type { TimelineItem, ClipItem, OverlayItem, MusicItem, VoiceoverItem } from '../timeline.js';

/**
 * Build template data for the timeline-summary prompt.
 * Computes absolute timeline positions from raw items (clip anchors → seconds).
 * Callers render with: renderPrompt('computed-timeline', buildComputedTimelineData(items))
 */
export function buildComputedTimelineData(items: TimelineItem[]): Record<string, unknown> {
  const clipItems = items.filter((i): i is ClipItem => i.type === 'clip');
  const timings = computeClipTimings(clipItems);
  const { startTimes: clipStartTimes, durations: clipDurations } = timings;

  function fmt(n: number) { return (Math.round(n * 10) / 10).toFixed(1); }

  const clips = clipItems.map((clip, i) => ({
    index: i,
    videoId: clip.videoId,
    timelineStart: fmt(clipStartTimes[i]),
    timelineEnd: fmt(clipStartTimes[i] + clipDurations[i]),
    duration: fmt(clipDurations[i]),
    start: secondsToTimestamp(sourceFileStartSeconds(clip)),
    end: secondsToTimestamp(sourceFileEndSeconds(clip)),
  }));

  const voiceovers = items
    .filter((i): i is VoiceoverItem => i.type === 'voiceover')
    .map((vo) => {
      const start = Math.max(0, clipAnchoredStart(timings, vo.startClip, vo.startOffset));
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
      const start = Math.max(0, clipAnchoredStart(timings, o.startClip, o.startOffset));
      const end = clipAnchoredEnd(timings, o.endClip ?? o.startClip, o.endOffset, clipItems);
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
      const start = Math.max(0, clipAnchoredStart(timings, m.startClip, m.startOffset));
      const end = clipAnchoredEnd(timings, m.endClip ?? m.startClip, m.endOffset);
      return {
        musicId: m.musicId,
        timelineStart: fmt(start),
        timelineEnd: fmt(end),
        duration: fmt(end - start),
        start: secondsToTimestamp(sourceFileStartSeconds(m)),
        end: secondsToTimestamp(sourceFileStartSeconds(m) + (end - start)),
      };
    });

  return { totalDuration: fmt(timings.total), clips, voiceovers, overlays, music };
}
