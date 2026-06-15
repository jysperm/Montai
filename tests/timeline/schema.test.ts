import { describe, expect, it } from 'vitest';
import { TimelineItemSchema, type TimelineItem } from '../../src/schemas/timeline.js';
import { resolveTimeline } from '../../src/schemas/timeline/resolve.js';

describe('TimelineItemSchema', () => {
  it('returns zod issues instead of throwing for malformed timestamps', () => {
    expect(() => TimelineItemSchema.safeParse({
      type: 'clip',
      videoId: 1,
      startTime: '00:10',
      endTime: 'oops',
    })).not.toThrow();

    const result = TimelineItemSchema.safeParse({
      type: 'clip',
      videoId: 1,
      startTime: '00:10',
      endTime: 'oops',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toMatchObject([
        { path: ['endTime'], message: 'must be MM:SS or MM:SS.s' },
      ]);
    }
  });

  it('reports missing fields on the selected item type', () => {
    const result = TimelineItemSchema.safeParse({
      type: 'clip',
      videoId: 1,
      startTime: '00:10',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].path).toEqual(['endTime']);
    }
  });

  it('normalizes legacy seconds fields before discriminating item types', () => {
    expect(TimelineItemSchema.parse({
      type: 'clip',
      videoId: 1,
      startTimeSeconds: 65,
      endTimeSeconds: 72.5,
    })).toMatchObject({
      type: 'clip',
      startTime: '01:05',
      endTime: '01:12.5',
    });

    expect(TimelineItemSchema.parse({
      type: 'voiceover',
      voiceoverId: 1,
      startClip: 0,
      audioStartSeconds: 2.5,
      audioEndSeconds: 10,
    })).toMatchObject({
      type: 'voiceover',
      startTime: '00:02.5',
      endTime: '00:10',
    });
  });

  it('reports voiceover endTime/startTime ordering errors during expansion', () => {
    const items: TimelineItem[] = [
      { type: 'clip', videoId: 1, startTime: '00:00', endTime: '00:20', playbackRate: 1, volume: 1 },
      { type: 'voiceover', voiceoverId: 1, startClip: 0, startOffset: 0, startTime: '00:10', endTime: '00:05', volume: 1 },
    ];

    const { errors } = resolveTimeline(
      items,
      {
        output: { resolution: '1080p', fps: 50 },
      } as any,
      'test',
      [{ id: 1, path: '/test/video.mp4' }],
      undefined,
      [],
      [{ id: 1, path: '/test/voiceover.wav', durationSeconds: 30 }],
    );

    expect(errors).toContain('Voiceover item (voiceoverId=1): endTime (00:05) must be greater than startTime (00:10)');
  });
});
