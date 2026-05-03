import { describe, it, expect } from 'vitest';
import { resolveStartFrame, clipStartFrame, totalTimelineFrames, totalTimelineSeconds, previewHash, stillHash } from '../../src/utils/preview-render.js';
import type { ExpandedTimeline } from '../../src/schemas/timeline.js';

const sampleSpec: ExpandedTimeline = {
  name: 'test',
  fps: 50,
  width: 1920,
  height: 1080,
  clips: [
    { clipId: 'a', videoId: 1, sourceFile: 'v1.mp4', startTimeSeconds: 0, endTimeSeconds: 4, playbackRate: 1, volume: 1 },
    { clipId: 'b', videoId: 1, sourceFile: 'v1.mp4', startTimeSeconds: 10, endTimeSeconds: 16, playbackRate: 1, volume: 1 },
    { clipId: 'c', videoId: 1, sourceFile: 'v1.mp4', startTimeSeconds: 20, endTimeSeconds: 22, playbackRate: 1, volume: 1, transition: { type: 'fade', durationSeconds: 0.5 } },
  ],
  textOverlays: [],
  audioTracks: [],
  voiceoverTracks: [],
};

describe('preview-render frame math', () => {
  it('totalTimelineFrames sums durations and subtracts transition overlaps', () => {
    // 4s + 6s + (2s - 0.5s overlap) = 11.5s @ 50fps = 575 frames
    expect(totalTimelineFrames(sampleSpec)).toBe(575);
    expect(totalTimelineSeconds(sampleSpec)).toBe(11.5);
  });

  it('clipStartFrame places clip 0 at frame 0', () => {
    expect(clipStartFrame(sampleSpec, 0)).toBe(0);
  });

  it('clipStartFrame places clip 1 (no incoming transition) right after clip 0', () => {
    expect(clipStartFrame(sampleSpec, 1)).toBe(200); // 4s * 50fps
  });

  it('clipStartFrame backs up by transition frames when clip has incoming transition', () => {
    // clip 2 starts after clip 1 ends, minus its own 0.5s incoming transition
    // (4 + 6) * 50 - 0.5 * 50 = 500 - 25 = 475
    expect(clipStartFrame(sampleSpec, 2)).toBe(475);
  });

  it('resolveStartFrame supports positive offset (from clip start)', () => {
    // clip 1 start (200) + 2s = 200 + 100 = 300
    expect(resolveStartFrame(sampleSpec, 1, 2)).toBe(300);
  });

  it('resolveStartFrame supports negative offset (from clip end)', () => {
    // clip 1 length is 6s @ 50fps = 300 frames; end of clip 1 = 200+300=500.
    // -1s offset = 500 - 50 = 450
    expect(resolveStartFrame(sampleSpec, 1, -1)).toBe(450);
  });

  it('resolveStartFrame clamps to total timeline range', () => {
    expect(resolveStartFrame(sampleSpec, 0, -100)).toBe(0); // way before start
    expect(resolveStartFrame(sampleSpec, 2, 1000)).toBe(574); // way past end
  });
});

describe('preview-render cache hashes', () => {
  it('previewHash is stable for identical inputs and changes when any input changes', () => {
    const h1 = previewHash(sampleSpec, 0, 5, 1);
    const h2 = previewHash(sampleSpec, 0, 5, 1);
    expect(h1).toBe(h2);
    expect(previewHash(sampleSpec, 0, 5, 2)).not.toBe(h1); // fps differs
    expect(previewHash(sampleSpec, 1, 5, 1)).not.toBe(h1); // start differs
    const altered = { ...sampleSpec, clips: [...sampleSpec.clips, sampleSpec.clips[0]] };
    expect(previewHash(altered, 0, 5, 1)).not.toBe(h1); // spec differs
  });

  it('stillHash is stable and frame-sensitive', () => {
    expect(stillHash(sampleSpec, 100)).toBe(stillHash(sampleSpec, 100));
    expect(stillHash(sampleSpec, 100)).not.toBe(stillHash(sampleSpec, 101));
  });
});
