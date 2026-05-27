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
import {
  audioMeta,
  expand,
  fixturesOutputDir,
  loadTimeline,
  videoMeta,
  voiceoverMeta,
} from './utils.js';

function generateTestFcpxml(...args: Parameters<typeof generateFcpxml>): string {
  return generateFcpxml(...args).replaceAll(fixturesOutputDir, '/fixtures/output');
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
  const items = loadTimeline('overlay-test');

  it('FCP snapshot (positions + animations)', () => {
    const { timeline } = expand(items, 'overlay-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    expect(xml).toContain('Essential Fade');
    expect(xml).toContain('keyframeAnimation');
    expect(xml).toContain('Essential Scale');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci snapshot (1x font size)', () => {
    const { timeline } = expand(items, 'overlay-test');
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

describe('rotation-test', () => {
  const items = loadTimeline('rotation-test');

  it('FCP snapshot (rotation + rotation with crop)', () => {
    const { timeline } = expand(items, 'rotation-test');
    const xml = generateTestFcpxml(timeline, videoMeta, { target: 'fcp' });
    // Rotation forces adjust-transform path even on FCP (adjust-crop has no rotation).
    // DaVinci output is identical for rotation — no target-specific handling.
    expect(xml).toContain('rotation="-90"');
    expect(xml).toContain('rotation="-180"');
    expect(xml).toContain('rotation="-270"');
    expect(xml).toContain('rotation="-45"');
    // rotation=0 is treated as "no rotation" and emits no adjust-transform.
    expect(xml).not.toContain('rotation="0"');
    expect(xml).not.toContain('rotation="-0"');
    expect(xml).toMatchSnapshot();
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
