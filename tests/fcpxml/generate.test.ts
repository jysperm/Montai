/**
 * Snapshot tests for FCPXML generation.
 *
 * Each test loads raw TimelineItem[] from a JSON file, expands it via
 * resolveTimeline, then snapshots the generated FCPXML. This covers the full
 * pipeline from raw items to final XML, so per-substring assertions are
 * unnecessary — the snapshot captures the entire output.
 *
 * Timeline JSON files are organized by feature (transitions, overlays, etc.)
 * and use placeholder video/music files independent of the example project.
 */

import { describe, it, expect } from 'vitest';
import { generateFcpxml } from '../../src/fcpxml/generate.js';
import { audioMeta, expand, expandForTimeline, fixturesOutputDir, loadTimeline, videoMeta, voiceoverMeta } from './utils.js';

function generateTestFcpxml(...args: Parameters<typeof generateFcpxml>): string {
  return generateFcpxml(...args).replaceAll(fixturesOutputDir, '/fixtures/output');
}

describe('transition-test', () => {
  const items = loadTimeline('transition-test');

  it('FCP snapshot', () => {
    const { timeline } = expand(items, 'transition-test');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'fcp' })).toMatchSnapshot();
  });
});

describe('overlay-test', () => {
  // Subtitle paragraph bounds and published X/Y offsets are derived from the
  // sequence shape, so each output shape is its own pinned timeline: 1080p uses
  // landscape footage, while 1080v/1080s use portrait footage.
  const cases = [
    { name: 'overlay-test.1080p', resolution: '1080p' },
    { name: 'overlay-test.1080v', resolution: '1080v' },
    { name: 'overlay-test.1080s', resolution: '1080s' },
  ] as const;

  for (const { name, resolution } of cases) {
    it(`FCP snapshot (positions + animations, ${resolution})`, () => {
      const { timeline } = expandForTimeline(name, resolution);
      expect(generateTestFcpxml(timeline, videoMeta, { target: 'fcp' })).toMatchSnapshot();
    });
  }

  it('DaVinci snapshot (1x font size)', () => {
    const { timeline } = expandForTimeline('overlay-test.1080p', '1080p');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'davinci' })).toMatchSnapshot();
  });
});

describe('crop-test', () => {
  const items = loadTimeline('crop-test');

  it('FCP snapshot (crop + Ken Burns via pan mode)', () => {
    const { timeline } = expand(items, 'crop-test');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'fcp' })).toMatchSnapshot();
  });

  it('DaVinci snapshot (crop + Ken Burns via adjust-transform)', () => {
    const { timeline } = expand(items, 'crop-test');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'davinci' })).toMatchSnapshot();
  });
});

describe('spatial-conform-test', () => {
  // Spatial conform depends on the sequence shape: landscape pillarboxes
  // cross-oriented sources (no fill), vertical/square fill-conform. Each shape
  // is its own snapshot of the per-clip transform/crop/conform output.
  const cases = ['1080p', '1080v', '1080s'] as const;

  for (const resolution of cases) {
    it(`FCP snapshot (${resolution})`, () => {
      const { timeline } = expandForTimeline('spatial-test.matrix', resolution);
      expect(generateTestFcpxml(timeline, videoMeta, { target: 'fcp' })).toMatchSnapshot();
    });
  }
});

describe('music-test', () => {
  const items = loadTimeline('music-test');

  it('FCP snapshot (volume, fades, auto-loop spine)', () => {
    const { timeline } = expand(items, 'music-test');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'fcp' }, audioMeta)).toMatchSnapshot();
  });

  it('DaVinci snapshot (auto-loop alternating lanes)', () => {
    const { timeline } = expand(items, 'music-test');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'davinci' }, audioMeta)).toMatchSnapshot();
  });
});

describe('voiceover-test', () => {
  const items = loadTimeline('voiceover-test');

  it('FCP snapshot (voiceover + background music)', () => {
    const { timeline } = expand(items, 'voiceover-test');
    expect(generateTestFcpxml(timeline, videoMeta, { target: 'fcp' }, audioMeta, voiceoverMeta)).toMatchSnapshot();
  });
});

describe('format and frame boundary regressions', () => {
  function makeTimeline() {
    const { timeline } = expand(loadTimeline('transition-test'), 'regression');
    return { ...timeline, width: 3840, height: 2160, fps: 50,
      textOverlays: [], audioTracks: [], voiceoverTracks: [],
      clips: [0, 1, 2].map(i => ({ ...timeline.clips[0],
        clipId: `clip-${i}`, sourceFile: `/media/${i}.mp4`,
        startTimeSeconds: 3, endTimeSeconds: 8, playbackRate: 1.2,
        transition: i ? { type: 'fade' as const, durationSeconds: 0.5 } : undefined,
      })),
    };
  }

  it.each(['hlg', 'pq'])('preserves %s at matching 4K 50fps and in mixed footage', transfer => {
    const timeline = makeTimeline();
    const meta = new Map(timeline.clips.map((clip, i) => [`${i}.mp4`, {
      width: 3840, height: 2160, fpsNum: 50, fpsDen: 1,
      colorPrimaries: i === 1 ? 'bt709' : 'bt2020',
      colorTransfer: i === 1 ? 'bt709' : transfer,
    }]));
    const xml = generateFcpxml(timeline, meta);
    const color = transfer === 'hlg' ? '9-18-9 (Rec. 2020 HLG)' : '9-16-9 (Rec. 2020 PQ)';
    expect(xml).toContain(`<format id="r1" frameDuration="1/50s" width="3840" height="2160" colorSpace="${color}"`);
    expect(xml).toContain('colorSpace="1-1-1 (Rec. 709)"');
    expect(xml).toContain('<library colorProcessing="wide-hdr">');
    expect(xml).not.toContain('FFVideoFormat');
    const assets = [...xml.matchAll(/<asset id="asset-\d+"[^>]* format="([^"]+)"/g)];
    expect(assets.map(a => a[1])).toEqual(['r1', expect.not.stringMatching(/^r1$/), 'r1']);
  });

  it('keeps retimed clips contiguous and transitions centered on the shared frame', () => {
    const xml = generateFcpxml(makeTimeline());
    const clips = [...xml.matchAll(/<asset-clip[^>]* offset="(\d+)\/50s" duration="(\d+)\/50s"/g)];
    expect(clips).toHaveLength(3);
    for (let i = 1; i < clips.length; i++) {
      expect(Number(clips[i][1])).toBe(Number(clips[i - 1][1]) + Number(clips[i - 1][2]));
    }
    const transitions = [...xml.matchAll(/<transition offset="(\d+)\/50s" duration="(\d+)\/50s"/g)];
    expect(transitions).toHaveLength(2);
    transitions.forEach((t, i) => expect(Number(t[1]) + Number(t[2]) / 2).toBe(Number(clips[i + 1][1])));
    expect(xml).toContain('<sequence format="r1" duration="625/50s"');
  });
});
