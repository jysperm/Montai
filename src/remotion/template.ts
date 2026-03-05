import type { ExpandedTimeline } from '../schemas/timeline.js';

export function calculateTotalFrames(spec: ExpandedTimeline): number {
  let total = 0;
  const { fps } = spec;

  for (const clip of spec.clips) {
    const clipDuration =
      (clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate;
    total += Math.round(clipDuration * fps);
    if (clip.transition) {
      const transitionFrames = Math.round(clip.transition.durationSeconds * fps);
      if (clip.transition.type !== 'none' && transitionFrames > 0) {
        total -= transitionFrames;
      }
    }
  }

  return Math.max(total, 1);
}
