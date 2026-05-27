import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { pathFor } from './index.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BPM = 92;
const BEAT_SECONDS = 60 / BPM;
const CHORDS = [
  [220.00, 261.63, 329.63],
  [196.00, 246.94, 293.66],
  [174.61, 220.00, 261.63],
  [196.00, 246.94, 329.63],
];

function clamp(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function sine(frequency: number, time: number) {
  return Math.sin(2 * Math.PI * frequency * time);
}

function triangle(frequency: number, time: number) {
  return (2 / Math.PI) * Math.asin(sine(frequency, time));
}

function decay(position: number, length: number) {
  return Math.exp(-position / length);
}

function makeWavHeader(dataBytes: number) {
  const buffer = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function sampleAt(time: number, durationSeconds: number) {
  const beat = time / BEAT_SECONDS;
  const beatIndex = Math.floor(beat);
  const chord = CHORDS[Math.floor(beatIndex / 8) % CHORDS.length];
  const beatPosition = (time % BEAT_SECONDS) / BEAT_SECONDS;
  const eighthPosition = (time % (BEAT_SECONDS / 2)) / (BEAT_SECONDS / 2);
  const arpNote = chord[beatIndex % chord.length] * (beatIndex % 2 === 0 ? 2 : 1);
  const masterFade = Math.min(1, time / 1.5, (durationSeconds - time) / 1.5);

  const pad = chord.reduce((sum, frequency) => sum + triangle(frequency / 2, time), 0) / chord.length;
  const shimmer = chord.reduce((sum, frequency) => sum + sine(frequency * 4, time), 0) / chord.length;
  const bass = sine(chord[0] / 2, time) * decay(beatPosition, 0.45);
  const arp = triangle(arpNote, time) * decay(eighthPosition, 0.18);
  const kick = sine(54 + 42 * decay(beatPosition, 0.08), time) * decay(beatPosition, 0.10) * (beatIndex % 4 === 0 ? 1 : 0);
  const hat = sine(6200, time) * decay(eighthPosition, 0.04);

  const left = (pad * 0.18 + shimmer * 0.04 + bass * 0.15 + arp * 0.10 + kick * 0.18 + hat * 0.025) * masterFade;
  const right = (pad * 0.16 + shimmer * 0.05 + bass * 0.13 + arp * 0.12 + kick * 0.16 + hat * 0.03) * masterFade;

  return [clamp(left * 0.55), clamp(right * 0.55)] as const;
}

function writeMusic(filename: string, durationSeconds: number) {
  const totalSamples = Math.round(durationSeconds * SAMPLE_RATE);
  const dataBytes = totalSamples * CHANNELS * BYTES_PER_SAMPLE;
  const buffer = Buffer.concat([makeWavHeader(dataBytes), Buffer.alloc(dataBytes)]);

  for (let i = 0; i < totalSamples; i++) {
    const [left, right] = sampleAt(i / SAMPLE_RATE, durationSeconds);
    const offset = 44 + i * CHANNELS * BYTES_PER_SAMPLE;
    buffer.writeInt16LE(Math.round(left * 32767), offset);
    buffer.writeInt16LE(Math.round(right * 32767), offset + 2);
  }

  writeFileSync(filename, buffer);
}

const longPath = pathFor('music-long.wav');
mkdirSync(dirname(longPath), { recursive: true });
writeMusic(longPath, 120);
writeMusic(pathFor('music-short.wav'), 5);
