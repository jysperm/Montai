import { describe, expect, it } from 'vitest';
import { renderTimeline } from '../../src/utils/render-timeline.js';
import type { TimelineItem } from '../../src/schemas/timeline-items.js';

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderTimeline', () => {
  it('keeps clip labels visible when the block is too narrow for padding', () => {
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTimeSeconds: 0, endTimeSeconds: 10, playbackRate: 1, volume: 1 },
      { type: 'clip', videoId: 10, startTimeSeconds: 0, endTimeSeconds: 10, playbackRate: 1, volume: 1 },
    ];

    const clipTrack = stripAnsi(renderTimeline(items, 14)[1]);

    expect(clipTrack).toContain('[v10]');
  });
});
