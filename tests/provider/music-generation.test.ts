/**
 * Test: verify that Lyria 2 music generation works via Vertex AI.
 *
 * Requires:
 * - GOOGLE_CLOUD_PROJECT env var
 * - GOOGLE_CLOUD_REGION env var (or defaults to us-central1)
 * - Application Default Credentials (gcloud auth application-default login)
 *
 * Run: npx vitest run tests/provider/music-generation.test.ts
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { callLyria } from '../../src/gemini/lyria.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skip('Lyria 2 music generation via Vertex AI', () => {
  it('generates a WAV audio buffer from a text prompt', async () => {
    const prompt = 'gentle acoustic guitar, warm and relaxed, medium tempo, suitable for a travel montage';

    console.log(`\n--- Generating music ---`);
    console.log(`Prompt: "${prompt}"`);
    console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT}`);
    console.log(`Region: ${process.env.GOOGLE_CLOUD_REGION ?? 'us-central1'}`);

    const wavBuffer = await callLyria(prompt);

    console.log(`\n--- Result ---`);
    console.log(`Buffer size: ${wavBuffer.length} bytes (${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // WAV files start with "RIFF" header
    const header = wavBuffer.subarray(0, 4).toString('ascii');
    console.log(`File header: ${header}`);

    expect(wavBuffer.length).toBeGreaterThan(100_000);
    expect(header).toBe('RIFF');

    const outPath = resolve(__dirname, 'lyria-output.wav');
    writeFileSync(outPath, wavBuffer);
    console.log(`Written to: ${outPath}`);
  }, 120_000);
});
