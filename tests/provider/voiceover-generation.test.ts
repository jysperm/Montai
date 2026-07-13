/**
 * Test: verify that Gemini-TTS voiceover synthesis works via the Cloud
 * Text-to-Speech API. Calls the service directly (not through src/generate) so this
 * isolates the service + our credentials from our own code.
 *
 * The three cases synthesize the same script so the outputs can be compared
 * side by side: plain text, text steered by a style prompt, and macOS `say`.
 *
 * Requires:
 * - GOOGLE_CLOUD_PROJECT env var
 * - Application Default Credentials (gcloud auth application-default login)
 *
 * Run: npx vitest run tests/provider/voiceover-generation.test.ts
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { GoogleAuth } from 'google-auth-library';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GEMINI_TTS_MODEL = 'gemini-2.5-flash-tts';

const TEXT = '这几天刚好赶上花市，走一圈下来，感觉整个春天都被搬到了这里。';

// Gemini-TTS ignores audioConfig.speakingRate/pitch, so pacing is only steerable
// through this prompt.
const STYLE_PROMPT = 'Read the following in a natural, conversational tone, at a slightly faster pace.';

// Candidate female voices, to be compared by ear. Aoede is the current default;
// Kore, the previous one, reads as flat — Google labels it "Firm".
const CANDIDATE_VOICES = ['Aoede', 'Kore', 'Sulafat', 'Leda', 'Laomedeia', 'Achernar'];

async function synthesizeWithCloudTts(
  input: { text: string; prompt?: string },
  voiceName: string,
): Promise<Buffer> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  expect(project, 'GOOGLE_CLOUD_PROJECT must be set').toBeTruthy();

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token;
  expect(accessToken, 'failed to obtain an access token from ADC').toBeTruthy();

  const body = {
    input,
    voice: { languageCode: 'cmn-CN', name: voiceName, modelName: GEMINI_TTS_MODEL },
    audioConfig: { audioEncoding: 'LINEAR16' },
  };

  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': project!,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cloud TTS error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { audioContent?: string };
  expect(data.audioContent, 'response contained no audioContent').toBeTruthy();

  return Buffer.from(data.audioContent!, 'base64');
}

function reportWav(wavBuffer: Buffer, outPath: string): void {
  console.log(`\n--- Result ---`);
  console.log(`Buffer size: ${wavBuffer.length} bytes (${(wavBuffer.length / 1024).toFixed(0)} KB)`);

  // LINEAR16 output is returned as a complete WAV, which starts with "RIFF".
  const header = wavBuffer.subarray(0, 4).toString('ascii');
  console.log(`File header: ${header}`);

  expect(wavBuffer.length).toBeGreaterThan(10_000);
  expect(header).toBe('RIFF');

  writeFileSync(outPath, wavBuffer);
  console.log(`Written to: ${outPath}`);
}

describe.skip('Gemini-TTS voiceover synthesis via Cloud Text-to-Speech', () => {
  it.each(CANDIDATE_VOICES)('synthesizes the script with the %s voice', async (voice) => {
    console.log(`\n--- Synthesizing voiceover (${voice}) ---`);
    console.log(`Text: "${TEXT}"`);
    console.log(`Prompt: "${STYLE_PROMPT}"`);
    console.log(`Model: ${GEMINI_TTS_MODEL}`);
    console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT}`);

    const wavBuffer = await synthesizeWithCloudTts({ text: TEXT, prompt: STYLE_PROMPT }, voice);
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
