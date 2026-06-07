/**
 * Snapshot tests for FCPXML generation.
 *
 * Each test loads raw TimelineItem[] from a JSON file, expands it via
 * expandTimeline, then verifies the generated FCPXML against a snapshot.
 * This covers the full pipeline from raw items to final XML.
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

function assetClipBlocks(xml: string): string[] {
  const blocks: string[] = [];
  for (const match of xml.matchAll(/<asset-clip\b[^>]*>/g)) {
    const start = match.index ?? 0;
    const tag = match[0];
    if (tag.endsWith('/>')) {
      blocks.push(tag);
      continue;
    }
    const end = xml.indexOf('</asset-clip>', start);
    blocks.push(xml.slice(start, end + '</asset-clip>'.length));
  }
  return blocks;
}

// --- Tests ---

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
    { name: 'overlay-test.1080p', resolution: '1080p', width: 1920, height: 1080 },
    { name: 'overlay-test.1080v', resolution: '1080v', width: 1080, height: 1920 },
    { name: 'overlay-test.1080s', resolution: '1080s', width: 1080, height: 1080 },
  ] as const;

  for (const { name, resolution, width, height } of cases) {
    it(`FCP snapshot (positions + animations, ${resolution})`, () => {
      const { timeline } = expandForTimeline(name, resolution);
      expect(timeline.width).toBe(width);
      expect(timeline.height).toBe(height);
      const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
      expect(xml).toContain('Essential Fade');
      expect(xml).toContain('keyframeAnimation');
      expect(xml).toContain('Essential Scale');
      expect(xml).toMatchSnapshot();
    });
  }

  it('DaVinci snapshot (1x font size)', () => {
    const { timeline } = expandForTimeline('overlay-test.1080p', '1080p');
    const fcpXml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    const davinciXml = generateTestFcpxml(timeline, videoMeta, { target: 'davinci' });
    expect(fcpXml).toContain('fontSize="160"');
    expect(davinciXml).toContain('fontSize="80"');
    expect(davinciXml).toMatchSnapshot();
  });
});

describe('crop-test', () => {
  const items = loadTimeline('crop-test');

  it('FCP snapshot (crop + Ken Burns via pan mode)', () => {
    const { timeline } = expand(items, 'crop-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    expect(xml).toContain('adjust-crop mode="crop"');
    expect(xml).toContain('adjust-crop mode="pan"');
    expect(xml).toContain('pan-rect');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci snapshot (crop + Ken Burns via adjust-transform)', () => {
    const { timeline } = expand(items, 'crop-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'davinci' });
    expect(xml).toContain('adjust-transform');
    expect(xml).not.toContain('adjust-crop');
    expect(xml).not.toContain('pan-rect');
    expect(xml).toMatchSnapshot();
  });
});

describe('spatial-conform-test', () => {
  it('landscape output contains portrait-oriented clips without fill', () => {
    const { timeline } = expandForTimeline('spatial-test.matrix', '1080p');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    const clips = assetClipBlocks(xml);

    expect(clips).toHaveLength(7);
    expect(clips.every(clip => !clip.includes('adjust-conform'))).toBe(true);
    expect(clips[1]).toContain('<adjust-transform scale="0.5091 0.5091" rotation="-45" />');
    expect(clips[3]).toContain('<adjust-transform scale="0.5625 0.5625" rotation="-90" />');
    expect(clips[4]).toContain('<crop-rect left="10" top="0" right="0" bottom="10" />');
    expect(clips[4]).toContain('<adjust-transform scale="0.5625 0.5625" rotation="-90" />');
    expect(clips[5]).toContain('<adjust-transform scale="1.7778 1.7778" rotation="-90" />');
    expect(clips[6]).toContain('<crop-rect left="10" top="0" right="0" bottom="10" />');
    expect(clips[6]).toContain('<adjust-transform scale="1.7778 1.7778" rotation="-90" />');
  });

  it('vertical output fill-conforms landscape-oriented clips, including rotated sources', () => {
    const { timeline } = expandForTimeline('spatial-test.matrix', '1080v');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    const clips = assetClipBlocks(xml);

    expect(clips).toHaveLength(7);
    expect(clips.every(clip => clip.includes('<adjust-conform type="fill" />'))).toBe(true);
    expect(clips[1]).toContain('<adjust-transform scale="0.5091 0.5091" rotation="-45" />');
    expect(clips[3]).toContain('<adjust-transform scale="0.5625 0.5625" rotation="-90" />');
    expect(clips[4]).toContain('<crop-rect left="10" top="0" right="0" bottom="10" />');
    expect(clips[4]).toContain('<adjust-transform scale="0.5625 0.5625" rotation="-90" />');
    expect(clips[5]).toContain('<adjust-transform scale="1.7778 1.7778" rotation="-90" />');
    expect(clips[6]).toContain('<crop-rect left="10" top="0" right="0" bottom="10" />');
    expect(clips[6]).toContain('<adjust-transform scale="1.7778 1.7778" rotation="-90" />');
  });

  it('square output fill-conforms both source orientations without extra rotation scale', () => {
    const { timeline } = expandForTimeline('spatial-test.matrix', '1080s');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    const clips = assetClipBlocks(xml);

    expect(clips).toHaveLength(7);
    expect(clips.every(clip => clip.includes('<adjust-conform type="fill" />'))).toBe(true);
    expect(clips[1]).toContain('<adjust-transform scale="0.5091 0.5091" rotation="-45" />');
    expect(clips[3]).toContain('<adjust-transform rotation="-90" />');
    expect(clips[4]).toContain('<crop-rect left="10" top="0" right="0" bottom="10" />');
    expect(clips[4]).toContain('<adjust-transform rotation="-90" />');
    expect(clips[5]).toContain('<adjust-transform rotation="-90" />');
    expect(clips[6]).toContain('<crop-rect left="10" top="0" right="0" bottom="10" />');
    expect(clips[6]).toContain('<adjust-transform rotation="-90" />');
    // The clip transform itself carries no rotation-fit scale (only rotation).
    // (Title overlays may carry their own transform scale, so match the clip form.)
    expect(clips[3]).not.toMatch(/adjust-transform scale="[^"]*" rotation/);
    expect(clips[5]).not.toMatch(/adjust-transform scale="[^"]*" rotation/);
  });
});

describe('music-test', () => {
  const items = loadTimeline('music-test');

  it('auto-loop corrections reported for short music', () => {
    const { corrections } = expand(items, 'music-test');
    expect(corrections.some(c => c.includes('auto-looped'))).toBe(true);
  });

  it('FCP snapshot (volume, fades, auto-loop spine)', () => {
    const { timeline } = expand(items, 'music-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' }, audioMeta);
    expect(xml).toContain('<adjust-volume amount="-6dB"/>');
    expect(xml).toContain('<spine lane="-');
    expect(xml).toContain('Cross Dissolve');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci snapshot (auto-loop alternating lanes)', () => {
    const { timeline } = expand(items, 'music-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'davinci' }, audioMeta);
    expect(xml).not.toMatch(/<spine lane="-[0-9]/);
    expect(xml).toMatchSnapshot();
  });
});

describe('voiceover-test', () => {
  const items = loadTimeline('voiceover-test');

  it('FCP snapshot (voiceover + background music)', () => {
    const { timeline } = expand(items, 'voiceover-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' }, audioMeta, voiceoverMeta);
    // Voiceover and music on separate lanes
    const lanes = [...xml.matchAll(/lane="(-\d+)"/g)].map(m => m[1]);
    expect(new Set(lanes).size).toBeGreaterThanOrEqual(2);
    expect(xml).toMatchSnapshot();
  });
});
