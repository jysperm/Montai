/**
 * Test: verify that Gemini-TTS voiceover synthesis works via the Gemini Developer
 * API (`models.generateContent`) using only a GEMINI_API_KEY — no Google Cloud /
 * ADC. Calls the SDK directly (not through src/generate) so this isolates the
 * service + our credentials from our own code, and can sweep candidate voices.
 *
 * The cases synthesize the same script so the outputs can be compared by ear:
 * each candidate Gemini voice, plus macOS `say`.
 *
 * Requires:
 * - GEMINI_API_KEY env var
 *
 * Run: npx vitest run tests/provider/voiceover-generation.test.ts
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { getGeminiClient } from '../../src/gemini/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

const TEXT = '这几天刚好赶上花市，走一圈下来，感觉整个春天都被搬到了这里。';

// Gemini-TTS has no explicit pacing controls, so delivery is steered by prefixing
// this instruction to the script.
const STYLE_PROMPT = 'Read the following in a natural, conversational tone, at a slightly faster pace: ';

// Candidate female voices, to be compared by ear. Aoede is the current default;
// Kore, the previous one, reads as flat — Google labels it "Firm".
const CANDIDATE_VOICES = ['Aoede', 'Kore', 'Sulafat', 'Leda', 'Laomedeia', 'Achernar'];

/** Wrap raw little-endian PCM in a minimal WAV (RIFF) container. */
function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function rateFromMime(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number(match[1]) : 24000;
}

async function synthesizeWithGeminiTts(text: string, voiceName: string): Promise<Buffer> {
  const response = await getGeminiClient().models.generateContent({
    model: TTS_MODEL,
    contents: STYLE_PROMPT + text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const data = part?.inlineData?.data;
  expect(data, 'response contained no inline audio data').toBeTruthy();
  return pcmToWav(Buffer.from(data!, 'base64'), rateFromMime(part!.inlineData?.mimeType));
}

function reportWav(wavBuffer: Buffer, outPath: string): void {
  console.log(`\n--- Result ---`);
  console.log(`Buffer size: ${wavBuffer.length} bytes (${(wavBuffer.length / 1024).toFixed(0)} KB)`);

  const header = wavBuffer.subarray(0, 4).toString('ascii');
  console.log(`File header: ${header}`);

  expect(wavBuffer.length).toBeGreaterThan(10_000);
  expect(header).toBe('RIFF');

  writeFileSync(outPath, wavBuffer);
  console.log(`Written to: ${outPath}`);
}

describe.skipIf(!process.env.GEMINI_API_KEY)('Gemini-TTS voiceover synthesis via Gemini API key', () => {
  it.each(CANDIDATE_VOICES)('synthesizes the script with the %s voice', async (voice) => {
    console.log(`\n--- Synthesizing voiceover (${voice}) ---`);
    console.log(`Text: "${TEXT}"`);
    console.log(`Model: ${TTS_MODEL}`);

    const wavBuffer = await synthesizeWithGeminiTts(TEXT, voice);
    reportWav(wavBuffer, resolve(__dirname, `gemini-tts-${voice}.wav`));
  }, 120_000);

  it('synthesizes the same script with the macOS `say` provider', () => {
    console.log(`\n--- Synthesizing voiceover (say) ---`);
    console.log(`Text: "${TEXT}"`);
    console.log(`Voice: Tingting`);

    const aiffPath = resolve(__dirname, 'say-output.aiff');
    const outPath = resolve(__dirname, 'say-output.wav');

    execFileSync('say', ['-v', 'Tingting', '-o', aiffPath, TEXT]);
    execFileSync('ffmpeg', ['-y', '-i', aiffPath, outPath], { stdio: ['ignore', 'ignore', 'pipe'] });

    reportWav(readFileSync(outPath), outPath);
  }, 120_000);
});
