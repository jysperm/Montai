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

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { expandTimeline, type TimelineItem } from '../../src/schemas/timeline-items.js';
import { generateFcpxml, type VideoFormatInfo, type AudioFormatInfo } from '../../src/fcpxml/generate.js';
import type { ProjectConfig } from '../../src/schemas/project.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTimeline(name: string): TimelineItem[] {
  const raw = readFileSync(resolve(__dirname, 'timelines', `${name}.json`), 'utf-8');
  return JSON.parse(raw);
}

// --- Test fixtures ---

const config: ProjectConfig = {
  assets: { videos: ['.'], music: [], voiceover: [] },
  language: 'en',
  output: { resolution: '1080p', fps: 50 },
  models: { analysis: 'gemini-3-flash-preview', editing: 'gemini-3.1-pro-preview' },
  effects: { languages: ['en'] },
};

// Two placeholder videos: 4K HLG 59.94fps, 60s each, with timecode
const videos = [
  { id: 1, path: '/test/video1.mp4', filename: 'video1.mp4' },
  { id: 2, path: '/test/video2.mp4', filename: 'video2.mp4' },
];

const VIDEO_FORMAT: VideoFormatInfo = {
  width: 3840, height: 2160, fpsNum: 60000, fpsDen: 1001,
  durationSeconds: 60, totalFrames: 3597,
  bitDepth: 10, colorPrimaries: 'bt2020', colorTransfer: 'hlg',
  audioChannels: 2, audioSampleRate: 48000,
  startTimecode: '01:00:00;00',
};

const videoMeta = new Map<string, VideoFormatInfo>([
  ['video1.mp4', VIDEO_FORMAT],
  ['video2.mp4', VIDEO_FORMAT],
]);

// Two placeholder music files: one long (no loop), one short (triggers loop)
const musicFiles = [
  { id: 1, path: '/test/music-long.mp3', filename: 'music-long.mp3', durationSeconds: 120 },
  { id: 2, path: '/test/music-short.mp3', filename: 'music-short.mp3', durationSeconds: 5 },
];

const audioMeta = new Map<string, AudioFormatInfo>([
  ['music-long.mp3', { durationSeconds: 120, sampleRate: 44100, channels: 2 }],
  ['music-short.mp3', { durationSeconds: 5, sampleRate: 44100, channels: 2 }],
]);

// One placeholder voiceover recording
const voiceoverFiles = [
  { id: 1, path: '/test/narration.wav', filename: 'narration.wav', durationSeconds: 30 },
];

const voiceoverMeta = new Map<string, AudioFormatInfo>([
  ['narration.wav', { durationSeconds: 30, sampleRate: 22050, channels: 1 }],
]);

function expand(items: TimelineItem[], name: string) {
  return expandTimeline(items, config, name, videos, undefined, musicFiles, voiceoverFiles);
}

// --- Tests ---

describe('transition-test', () => {
  const items = loadTimeline('transition-test');

  it('FCP snapshot', () => {
    const { timeline } = expand(items, 'transition-test');
    expect(generateFcpxml(timeline, videoMeta, { target: 'fcp' })).toMatchSnapshot();
  });
});

describe('overlay-test', () => {
  const items = loadTimeline('overlay-test');

  it('FCP snapshot (positions + animations)', () => {
    const { timeline } = expand(items, 'overlay-test');
    const xml = generateFcpxml(timeline, videoMeta, { target: 'fcp' });
    expect(xml).toContain('Essential Fade');
    expect(xml).toContain('keyframeAnimation');
    expect(xml).toContain('Essential Scale');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci snapshot (1x font size)', () => {
    const { timeline } = expand(items, 'overlay-test');
    const fcpXml = generateFcpxml(timeline, videoMeta, { target: 'fcp' });
    const davinciXml = generateFcpxml(timeline, videoMeta, { target: 'davinci' });
    expect(fcpXml).toContain('fontSize="160"');
    expect(davinciXml).toContain('fontSize="80"');
    expect(davinciXml).toMatchSnapshot();
  });
});

describe('crop-test', () => {
  const items = loadTimeline('crop-test');

  it('FCP snapshot (crop + Ken Burns via pan mode)', () => {
    const { timeline } = expand(items, 'crop-test');
    const xml = generateFcpxml(timeline, videoMeta, { target: 'fcp' });
    expect(xml).toContain('adjust-crop mode="crop"');
    expect(xml).toContain('adjust-crop mode="pan"');
    expect(xml).toContain('pan-rect');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci snapshot (crop + Ken Burns via adjust-transform)', () => {
    const { timeline } = expand(items, 'crop-test');
    const xml = generateFcpxml(timeline, videoMeta, { target: 'davinci' });
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
    const xml = generateFcpxml(timeline, videoMeta, { target: 'fcp' });
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
    const xml = generateFcpxml(timeline, videoMeta, { target: 'fcp' }, audioMeta);
    expect(xml).toContain('<spine lane="-');
    expect(xml).toContain('Cross Dissolve');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci snapshot (auto-loop alternating lanes)', () => {
    const { timeline } = expand(items, 'music-test');
    const xml = generateFcpxml(timeline, videoMeta, { target: 'davinci' }, audioMeta);
    expect(xml).not.toMatch(/<spine lane="-[0-9]/);
    expect(xml).toMatchSnapshot();
  });
});

describe('voiceover-test', () => {
  const items = loadTimeline('voiceover-test');

  it('FCP snapshot (voiceover + background music)', () => {
    const { timeline } = expand(items, 'voiceover-test');
    const xml = generateFcpxml(timeline, videoMeta, { target: 'fcp' }, audioMeta, voiceoverMeta);
    // Voiceover and music on separate lanes
    const lanes = [...xml.matchAll(/lane="(-\d+)"/g)].map(m => m[1]);
    expect(new Set(lanes).size).toBeGreaterThanOrEqual(2);
    expect(xml).toMatchSnapshot();
  });
});
