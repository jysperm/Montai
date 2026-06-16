import { describe, expect, it } from 'vitest';
import { renderPrompt } from '../../src/prompts/index.js';
import { buildComputedTimelineData } from '../../src/schemas/timeline/compute.js';
import type { TimelineItem } from '../../src/schemas/timeline.js';

describe('computed timeline prompt', () => {
  it('renders timeline positions and source start/end times', () => {
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTime: '00:10', endTime: '00:20', playbackRate: 1, volume: 1 },
      { type: 'clip', videoId: 2, startTime: '01:00', endTime: '01:15', playbackRate: 2, volume: 1, transition: { type: 'fade', durationSeconds: 0.5 } },
      { type: 'overlay', text: 'Title\nSubtitle', startClip: 0, startOffset: 2, endClip: 1, endOffset: -1, position: 'bottom-center', style: 'subtitle', animation: 'none' },
      { type: 'music', startClip: 0, startOffset: 0, endClip: 1, endOffset: 0, musicId: 3, startTime: '00:05', volume: 0.3, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { type: 'voiceover', voiceoverId: 4, startClip: 1, startOffset: 1, startTime: '00:02.5', endTime: '00:08', volume: 1 },
    ];

    expect(renderPrompt('computed-timeline', buildComputedTimelineData(items))).toMatchInlineSnapshot(`
      "## Computed Timeline (17.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s (10.0s) vid=1 source=00:10–00:20 [0]
        9.5–17.0s (7.5s) vid=2 source=01:00–01:15 [1]

      Voiceovers:
        10.5–16.0s vo=4 (5.5s)

      Overlays:
        2.0–16.0s "Title Subt..." (14.0s)

      Music:
        0.0–17.0s (17.0s) music=3 source=00:05–00:22
      "
    `);
  });
});
