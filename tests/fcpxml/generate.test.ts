/**
 * Snapshot tests for FCPXML generation.
 *
 * Each test builds a minimal ExpandedTimeline and verifies the generated FCPXML.
 * Snapshots capture the full XML structure so regressions in element ordering,
 * attribute values, or nesting are caught automatically.
 */

import { describe, it, expect } from 'vitest';
import { generateFcpxml } from '../../src/fcpxml/generate.js';
import type { ExpandedTimeline } from '../../src/schemas/timeline.js';

// Shared video metadata (30fps, 60s source, 1080p)
const videoMeta = new Map([
  ['video1.mp4', { width: 1920, height: 1080, fps: 30, durationSeconds: 60, fpsNum: 30000, fpsDen: 1001, colorSpace: null, timecode: null }],
  ['video2.mp4', { width: 1920, height: 1080, fps: 30, durationSeconds: 60, fpsNum: 30000, fpsDen: 1001, colorSpace: null, timecode: null }],
]);

const audioMeta = new Map([
  ['music.wav', { durationSeconds: 10, sampleRate: 48000, channels: 2 }],
]);

function makeClip(id: number, start: number, end: number, opts?: {
  transition?: { type: 'fade' | 'slide' | 'wipe'; durationSeconds: number; direction?: string };
  playbackRate?: number;
  volume?: number;
}) {
  return {
    clipId: `c${id}`,
    videoId: id,
    sourceFile: `/test/video${id}.mp4`,
    startTimeSeconds: start,
    endTimeSeconds: end,
    playbackRate: opts?.playbackRate ?? 1,
    volume: opts?.volume ?? 1,
    transition: opts?.transition,
  };
}

describe('generateFcpxml', () => {
  it('single clip without audio or overlays', () => {
    const spec: ExpandedTimeline = {
      name: 'basic', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 5, 15)],
      textOverlays: [], audioTracks: [],
    };
    expect(generateFcpxml(spec, videoMeta)).toMatchSnapshot();
  });

  it('two clips with fade transition', () => {
    const spec: ExpandedTimeline = {
      name: 'transition-test', fps: 25, width: 1920, height: 1080,
      clips: [
        makeClip(1, 5, 20),
        makeClip(2, 10, 30, { transition: { type: 'fade', durationSeconds: 1 } }),
      ],
      textOverlays: [], audioTracks: [],
    };
    expect(generateFcpxml(spec, videoMeta)).toMatchSnapshot();
  });

  it('clip with text overlay', () => {
    const spec: ExpandedTimeline = {
      name: 'overlay-test', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 0, 20)],
      textOverlays: [{
        text: 'Hello World',
        startTimeSeconds: 2,
        endTimeSeconds: 8,
        position: 'bottom-center' as const,
        style: 'subtitle' as const,
      }],
      audioTracks: [],
    };
    expect(generateFcpxml(spec, videoMeta)).toMatchSnapshot();
  });

  it('single audio track with volume and fades', () => {
    const spec: ExpandedTimeline = {
      name: 'audio-test', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 0, 30)],
      textOverlays: [],
      audioTracks: [{
        sourceFile: '/test/music.wav', startTimeSeconds: 0, endTimeSeconds: 10,
        audioStartSeconds: 2, volume: 0.3, fadeInSeconds: 1, fadeOutSeconds: 1,
      }],
    };
    expect(generateFcpxml(spec, videoMeta, { target: 'fcp' }, audioMeta)).toMatchSnapshot();
  });

  it('audio auto-loop: FCP uses spine with transitions', () => {
    const spec: ExpandedTimeline = {
      name: 'loop-fcp', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 0, 30)],
      textOverlays: [],
      audioTracks: [
        { sourceFile: '/test/music.wav', startTimeSeconds: 0, endTimeSeconds: 10, audioStartSeconds: 0, volume: 0.3, fadeInSeconds: 2, fadeOutSeconds: 1 },
        { sourceFile: '/test/music.wav', startTimeSeconds: 9, endTimeSeconds: 19, audioStartSeconds: 0, volume: 0.3, fadeInSeconds: 1, fadeOutSeconds: 1 },
        { sourceFile: '/test/music.wav', startTimeSeconds: 18, endTimeSeconds: 25, audioStartSeconds: 0, volume: 0.3, fadeInSeconds: 1, fadeOutSeconds: 2 },
      ],
    };
    const xml = generateFcpxml(spec, videoMeta, { target: 'fcp' }, audioMeta);
    expect(xml).toContain('<spine lane="-1"');
    expect(xml).toContain('<transition name="Cross Dissolve"');
    expect(xml).toMatchSnapshot();
  });

  it('audio auto-loop: DaVinci uses alternating lanes', () => {
    const spec: ExpandedTimeline = {
      name: 'loop-davinci', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 0, 30)],
      textOverlays: [],
      audioTracks: [
        { sourceFile: '/test/music.wav', startTimeSeconds: 0, endTimeSeconds: 10, audioStartSeconds: 0, volume: 0.3, fadeInSeconds: 2, fadeOutSeconds: 1 },
        { sourceFile: '/test/music.wav', startTimeSeconds: 9, endTimeSeconds: 19, audioStartSeconds: 0, volume: 0.3, fadeInSeconds: 1, fadeOutSeconds: 1 },
        { sourceFile: '/test/music.wav', startTimeSeconds: 18, endTimeSeconds: 25, audioStartSeconds: 0, volume: 0.3, fadeInSeconds: 1, fadeOutSeconds: 2 },
      ],
    };
    const xml = generateFcpxml(spec, videoMeta, { target: 'davinci' }, audioMeta);
    expect(xml).not.toMatch(/<spine lane="-[0-9]/);
    const lanes = [...xml.matchAll(/lane="(-\d+)"/g)].map(m => m[1]);
    expect(lanes).toEqual(['-1', '-2', '-1']);
    expect(xml).toMatchSnapshot();
  });

  it('slide and wipe transitions with direction params', () => {
    const spec: ExpandedTimeline = {
      name: 'slide-wipe', fps: 25, width: 1920, height: 1080,
      clips: [
        makeClip(1, 5, 20),
        makeClip(2, 10, 30, { transition: { type: 'slide', durationSeconds: 1, direction: 'from-left' } }),
        makeClip(1, 0, 15, { transition: { type: 'wipe', durationSeconds: 0.5, direction: 'from-bottom' } }),
      ],
      textOverlays: [], audioTracks: [],
    };
    const xml = generateFcpxml(spec, videoMeta);
    expect(xml).toContain('name="Slide"');
    expect(xml).toContain('name="Wipe"');
    expect(xml).toMatchSnapshot();
  });

  it('overlay animations: fade, slide, pop', () => {
    const spec: ExpandedTimeline = {
      name: 'anim-test', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 0, 30)],
      textOverlays: [
        { text: 'Fade In', startTimeSeconds: 0, endTimeSeconds: 5, position: 'bottom-center' as const, style: 'subtitle' as const, animation: { type: 'fade' as const, durationSeconds: 0.3 } },
        { text: 'Slide Up', startTimeSeconds: 6, endTimeSeconds: 12, position: 'bottom-left' as const, style: 'subtitle' as const, animation: { type: 'slide' as const, durationSeconds: 0.3 } },
        { text: 'Pop', startTimeSeconds: 13, endTimeSeconds: 18, position: 'center' as const, style: 'title' as const, animation: { type: 'pop' as const, durationSeconds: 0.3 } },
      ],
      audioTracks: [],
    };
    const xml = generateFcpxml(spec, videoMeta);
    expect(xml).toContain('Essential Fade');
    expect(xml).toContain('keyframeAnimation');
    expect(xml).toContain('Essential Scale');
    expect(xml).toMatchSnapshot();
  });

  it('multiple clips from the same video share one asset', () => {
    const spec: ExpandedTimeline = {
      name: 'dedup-test', fps: 25, width: 1920, height: 1080,
      clips: [
        makeClip(1, 0, 10),
        makeClip(1, 20, 30),
        makeClip(1, 40, 50),
      ],
      textOverlays: [], audioTracks: [],
    };
    const xml = generateFcpxml(spec, videoMeta);
    // Should have exactly one asset for video1.mp4
    const assetMatches = xml.match(/<asset id="/g);
    expect(assetMatches).toHaveLength(1);
    // All clips reference the same asset
    const refMatches = [...xml.matchAll(/ref="(asset-\d+)"/g)].map(m => m[1]);
    expect(new Set(refMatches).size).toBe(1);
  });

  it('video with start timecode uses frame-based offset', () => {
    const metaWithTc = new Map([
      ['video1.mp4', {
        width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001,
        durationSeconds: 60, startTimecode: '01:00:00;00',
      }],
    ]);
    const spec: ExpandedTimeline = {
      name: 'tc-test', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 5, 15)],
      textOverlays: [], audioTracks: [],
    };
    const xml = generateFcpxml(spec, metaWithTc);
    // With timecode 01:00:00;00 at 29.97fps, the start offset should use fpsNum/fpsDen rational
    expect(xml).toContain('/30000s');
    expect(xml).toMatchSnapshot();
  });

  it('clip with static crop', () => {
    const spec: ExpandedTimeline = {
      name: 'crop-test', fps: 25, width: 1920, height: 1080,
      clips: [{
        ...makeClip(1, 5, 15),
        crop: { left: 10, top: 15, right: 10, bottom: 15 },
      }],
      textOverlays: [], audioTracks: [],
    };
    const xml = generateFcpxml(spec, videoMeta);
    expect(xml).toContain('adjust-crop mode="crop"');
    expect(xml).toContain('crop-rect left="10" top="15" right="10" bottom="15"');
    expect(xml).toMatchSnapshot();
  });

  it('clip with Ken Burns (pan) crop', () => {
    const spec: ExpandedTimeline = {
      name: 'kenburns-test', fps: 25, width: 1920, height: 1080,
      clips: [{
        ...makeClip(1, 0, 20),
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        cropEnd: { left: 25, top: 20, right: 25, bottom: 30 },
      }],
      textOverlays: [], audioTracks: [],
    };
    const xml = generateFcpxml(spec, videoMeta);
    expect(xml).toContain('adjust-crop mode="pan"');
    expect(xml).toContain('pan-rect left="0" top="0" right="0" bottom="0"');
    expect(xml).toContain('pan-rect left="25" top="20" right="25" bottom="30"');
    expect(xml).toMatchSnapshot();
  });

  it('Ken Burns with cropEnd only (no crop) defaults start to full frame', () => {
    const spec: ExpandedTimeline = {
      name: 'kenburns-default', fps: 25, width: 1920, height: 1080,
      clips: [{
        ...makeClip(1, 0, 10),
        cropEnd: { left: 25, top: 25, right: 25, bottom: 25 },
      }],
      textOverlays: [], audioTracks: [],
    };
    const xml = generateFcpxml(spec, videoMeta);
    expect(xml).toContain('adjust-crop mode="pan"');
    // First pan-rect should default to full frame (all zeros)
    expect(xml).toContain('pan-rect left="0" top="0" right="0" bottom="0"');
    expect(xml).toContain('pan-rect left="25" top="25" right="25" bottom="25"');
    expect(xml).toMatchSnapshot();
  });

  it('DaVinci static crop uses adjust-transform instead of adjust-crop', () => {
    const spec: ExpandedTimeline = {
      name: 'davinci-crop', fps: 25, width: 1920, height: 1080,
      clips: [{
        ...makeClip(1, 5, 15),
        crop: { left: 20, top: 15, right: 20, bottom: 15 },
      }],
      textOverlays: [], audioTracks: [],
    };
    const fcpXml = generateFcpxml(spec, videoMeta, { target: 'fcp' });
    const davinciXml = generateFcpxml(spec, videoMeta, { target: 'davinci' });
    // FCP uses adjust-crop
    expect(fcpXml).toContain('adjust-crop mode="crop"');
    expect(fcpXml).not.toContain('adjust-transform');
    // DaVinci uses adjust-transform (scale + position) to avoid black bars
    expect(davinciXml).toContain('adjust-transform');
    expect(davinciXml).not.toContain('adjust-crop');
    expect(davinciXml).toMatchSnapshot();
  });

  it('DaVinci Ken Burns falls back to static adjust-transform at cropEnd', () => {
    const spec: ExpandedTimeline = {
      name: 'davinci-kb', fps: 25, width: 1920, height: 1080,
      clips: [{
        ...makeClip(1, 0, 10),
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        cropEnd: { left: 25, top: 20, right: 25, bottom: 20 },
      }],
      textOverlays: [], audioTracks: [],
    };
    const fcpXml = generateFcpxml(spec, videoMeta, { target: 'fcp' });
    const davinciXml = generateFcpxml(spec, videoMeta, { target: 'davinci' });
    // FCP uses adjust-crop mode="pan" with two pan-rects
    expect(fcpXml).toContain('adjust-crop mode="pan"');
    expect(fcpXml).toContain('pan-rect');
    // DaVinci falls back to static adjust-transform using cropEnd values
    expect(davinciXml).toContain('adjust-transform');
    expect(davinciXml).not.toContain('adjust-crop');
    expect(davinciXml).not.toContain('pan-rect');
    expect(davinciXml).toMatchSnapshot();
  });

  it('DaVinci font size is 1x, FCP is 2x', () => {
    const spec: ExpandedTimeline = {
      name: 'scale-test', fps: 25, width: 1920, height: 1080,
      clips: [makeClip(1, 0, 20)],
      textOverlays: [{
        text: 'Test', startTimeSeconds: 0, endTimeSeconds: 5,
        position: 'center' as const, style: 'title' as const,
      }],
      audioTracks: [],
    };
    const fcpXml = generateFcpxml(spec, videoMeta, { target: 'fcp' });
    const davinciXml = generateFcpxml(spec, videoMeta, { target: 'davinci' });
    // FCP title uses 160pt (80*2), DaVinci uses 80pt (80*1)
    expect(fcpXml).toContain('fontSize="160"');
    expect(davinciXml).toContain('fontSize="80"');
  });
});
