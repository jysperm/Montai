import type { EditSpec } from '../schemas/edit-spec.js';

export function calculateTotalFrames(spec: EditSpec): number {
  let total = 0;
  const { fps } = spec;

  if (spec.titleCard) {
    total += Math.round(spec.titleCard.durationSeconds * fps);
  }

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

  if (spec.endCard) {
    total += Math.round(spec.endCard.durationSeconds * fps);
  }

  return Math.max(total, 1);
}
