import { describe, expect, it } from 'vitest';
import { renderPrompt } from '../../src/prompts/index.js';
import { buildComputedTimelineData } from '../../src/schemas/timeline/compute.js';
import type { TimelineItem } from '../../src/schemas/timeline.js';

describe('computed timeline prompt', () => {
  it('renders timeline positions and music start/end times', () => {
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTime: '00:10', endTime: '00:20', playbackRate: 1, volume: 1 },
      { type: 'clip', videoId: 2, startTime: '01:00', endTime: '01:15', playbackRate: 1, volume: 1, transition: { type: 'fade', durationSeconds: 0.5 } },
      { type: 'overlay', text: 'Title\nSubtitle', startClip: 0, startOffset: 2, endClip: 1, endOffset: -1, position: 'bottom-center', style: 'subtitle', animation: 'none' },
      { type: 'music', startClip: 0, startOffset: 0, endClip: 1, endOffset: 0, musicId: 3, startTime: '00:05', volume: 0.3, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { type: 'voiceover', voiceoverId: 4, startClip: 1, startOffset: 1, startTime: '00:02.5', endTime: '00:08', volume: 1 },
    ];

    expect(renderPrompt('computed-timeline', buildComputedTimelineData(items))).toMatchInlineSnapshot(`
      "## Computed Timeline (24.5s in total)

      Format: \`start–end\` is the absolute position in seconds on the timeline of the final video; parenthesized value is the duration; bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s vid=1 [0]
        9.5–24.5s vid=2 [1]

      Voiceovers:
        10.5–16.0s vo=4 (5.5s)

      Overlays:
        2.0–23.5s "Title Subt..." (21.5s)

      Music:
        0.0–24.5s music=3 (24.5s, startTime=00:05, endTime=00:29.5)
      "
    `);
  });
});
