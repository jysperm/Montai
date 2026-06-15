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
  // Overlay Position params are derived from the sequence shape (see
  // fcpTitlePositionValues / buildTitleLayout), so each output shape is its own
  // pinned timeline: 1080p uses landscape footage, 1080v/1080s portrait footage.
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
