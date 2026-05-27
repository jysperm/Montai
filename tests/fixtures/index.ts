import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AudioFormatInfo, VideoFormatInfo } from '../../src/fcpxml/generate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const outputDir = resolve(__dirname, 'output');
export const pathFor = (filename: string) => resolve(outputDir, filename);

export const VIDEO_FORMAT: VideoFormatInfo = {
  width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
  durationSeconds: 30, totalFrames: 900,
  bitDepth: 8, colorPrimaries: 'bt709', colorTransfer: 'bt709',
  audioChannels: 2, audioSampleRate: 48000,
};

export const videos = [
  { id: 1, path: pathFor('landscape.mp4'), filename: 'landscape.mp4', width: 1920, height: 1080 },
  { id: 2, path: pathFor('portrait-misoriented.mp4'), filename: 'portrait-misoriented.mp4', width: 1920, height: 1080 },
  { id: 3, path: pathFor('portrait.mp4'), filename: 'portrait.mp4', width: 1080, height: 1920 },
  { id: 4, path: pathFor('landscape-misoriented.mp4'), filename: 'landscape-misoriented.mp4', width: 1080, height: 1920 },
];

export const videoMeta = new Map<string, VideoFormatInfo>([
  ['landscape.mp4', { ...VIDEO_FORMAT, width: 1920, height: 1080 }],
  ['portrait.mp4', { ...VIDEO_FORMAT, width: 1080, height: 1920 }],
  ['portrait-misoriented.mp4', { ...VIDEO_FORMAT, width: 1920, height: 1080 }],
  ['landscape-misoriented.mp4', { ...VIDEO_FORMAT, width: 1080, height: 1920 }],
]);

export const musicFiles = [
  { id: 1, path: pathFor('music-long.wav'), filename: 'music-long.wav', durationSeconds: 120 },
  { id: 2, path: pathFor('music-short.wav'), filename: 'music-short.wav', durationSeconds: 5 },
];

export const musicMeta = new Map<string, AudioFormatInfo>([
  ['music-long.wav', { durationSeconds: 120, sampleRate: 48000, channels: 2 }],
  ['music-short.wav', { durationSeconds: 5, sampleRate: 48000, channels: 2 }],
]);

export const voiceoverFiles = [
  { id: 1, path: pathFor('narration.wav'), filename: 'narration.wav', durationSeconds: /* narration-duration:start */42/* narration-duration:end */ },
];

export const voiceoverMeta = new Map<string, AudioFormatInfo>([
  ['narration.wav', { durationSeconds: /* narration-duration:start */42/* narration-duration:end */, sampleRate: 48000, channels: 1 }],
]);
