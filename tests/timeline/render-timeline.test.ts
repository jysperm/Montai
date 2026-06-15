import { describe, expect, it } from 'vitest';
import { formatGeneratedMusicPrompt, renderTimeline } from '../../src/utils/render-timeline.js';
import type { TimelineItem } from '../../src/schemas/timeline.js';

describe('renderTimeline', () => {
  it('keeps clip labels visible when the block is too narrow for padding', () => {
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTime: '00:00', endTime: '00:10', playbackRate: 1, volume: 1 },
      { type: 'clip', videoId: 10, startTime: '00:00', endTime: '00:10', playbackRate: 1, volume: 1 },
    ];

    expect(render(items, 14)).toMatchInlineSnapshot(`
      "  20s | 2 clips
        [v1 ][v10]"
    `);
  });

  it('lays out clips with a generated-music track labelled by its prompt', () => {
    const label = formatGeneratedMusicPrompt('Upbeat and modern motivational electronic travel soundtrack with bright percussion');
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTime: '00:00', endTime: '00:20', playbackRate: 1, volume: 1 },
      { type: 'music', startClip: 0, startOffset: 0, endOffset: 0, musicId: 1, startTime: '00:00', volume: 0.3, fadeInSeconds: 0, fadeOutSeconds: 0 },
    ];

    expect(render(items, 90, new Map([[1, label]]))).toMatchInlineSnapshot(`
      "  20s | 1 clips, 1 music
        [                                         v1                                         ]
        ‹♫                   Upbeat and modern motivational electronic...                   ♫›"
    `);
  });
});

describe('formatGeneratedMusicPrompt', () => {
  it('truncates a long prompt at a word boundary with an ellipsis', () => {
    expect(formatGeneratedMusicPrompt('Upbeat and modern motivational electronic travel soundtrack with bright percussion'))
      .toMatchInlineSnapshot(`"Upbeat and modern motivational electronic..."`);
  });
});

function render(items: TimelineItem[], width: number, musicNames?: Map<number, string>): string {
  return renderTimeline(items, width, musicNames).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}
