/**
 * Test: verify that Lyria 3 music generation works via the Gemini Developer API
 * (Interactions API) using only a GEMINI_API_KEY — no Google Cloud / ADC.
 *
 * Calls the production `callLyria` so this covers the real code path, including
 * the instrumental-only constraint.
 *
 * Requires:
 * - GEMINI_API_KEY env var
 *
 * Run: npx vitest run tests/provider/music-generation.test.ts
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { callLyria } from '../../src/gemini/lyria.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env.GEMINI_API_KEY)('Lyria 3 music generation via Gemini API key', () => {
  it('generates an instrumental audio clip from a text prompt', async () => {
    const prompt = 'gentle acoustic guitar, warm and relaxed, medium tempo, suitable for a travel montage';

    console.log(`\n--- Generating music ---`);
    console.log(`Prompt: "${prompt}"`);

    const { buffer, extension } = await callLyria(prompt);

    console.log(`\n--- Result ---`);
    console.log(`Extension: ${extension}`);
    console.log(`Buffer size: ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

    expect(buffer.length).toBeGreaterThan(100_000);

    const outPath = resolve(__dirname, `lyria3-output.${extension}`);
    writeFileSync(outPath, buffer);
    console.log(`Written to: ${outPath}`);
  }, 180_000);
});
