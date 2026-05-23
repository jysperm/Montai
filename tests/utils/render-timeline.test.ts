import { describe, expect, it } from 'vitest';
import { formatGeneratedMusicPrompt, renderTimeline } from '../../src/utils/render-timeline.js';
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

  it('formats generated music prompts without gen prefix and at word boundary', () => {
    const prompt = 'Upbeat and modern motivational electronic travel soundtrack with bright percussion';
    const label = formatGeneratedMusicPrompt(prompt);
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTimeSeconds: 0, endTimeSeconds: 20, playbackRate: 1, volume: 1 },
      { type: 'music', startClip: 0, endOffset: 0, musicId: 1, volume: 0.3 },
    ];

    const audioTrack = stripAnsi(renderTimeline(items, 90, new Map([[1, label]]))[2]);

    expect(label).toBe('Upbeat and modern motivational electronic...');
    expect(audioTrack).toContain(label);
    expect(audioTrack).not.toContain('gen:');
  });
});
