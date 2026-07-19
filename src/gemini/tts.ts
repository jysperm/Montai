import createDebug from 'debug';
import { getGeminiClient } from './client.js';
import type { VoiceStyle } from '../generate/tts.js';

// Gemini-TTS via the Gemini Developer API (models.generateContent), authenticated
// by GEMINI_API_KEY alone. Same value as the `models.voiceoverGeneration` option
// that selects this provider.
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// Gemini-TTS prebuilt voices per style. Language-independent. Picked for a warm,
// conversational delivery — the "Firm" voices read as flat newsreader narration.
const GEMINI_VOICES: Record<VoiceStyle, string> = {
  female: 'Aoede',
  male: 'Puck',
};

// Gemini-TTS has no explicit pacing/tone controls, so delivery is only steerable
// by prefixing this instruction to the script. Its default delivery is slow and flat.
const GEMINI_STYLE_PROMPT = 'Read the following in a natural, conversational tone, at a slightly faster pace: ';

const debugAgent = createDebug('montai:agent');
const debugReq = createDebug('montai:req');
const debugRes = createDebug('montai:res');

export interface GeminiTtsOptions {
  text: string;
  voice: VoiceStyle;
  language: string;
}

/**
 * Everything besides the script that shapes the audio, so callers can key a cache
 * on it — changing the voice or the style prompt must invalidate old tracks.
 */
export function geminiTtsSignature(opts: Omit<GeminiTtsOptions, 'text'>): string {
  return [
    GEMINI_TTS_MODEL,
    opts.language,
    GEMINI_VOICES[opts.voice],
    GEMINI_STYLE_PROMPT,
  ].join(':');
}

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

/** Pull the sample rate out of a mime type like "audio/L16;codec=pcm;rate=24000". */
function rateFromMime(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number(match[1]) : 24000;
}

/**
 * Google Gemini-TTS via the Gemini Developer API. The API returns raw 24kHz mono
 * 16-bit PCM, which this wraps into a complete WAV. Requires GEMINI_API_KEY.
 */
export async function callGeminiTts(opts: GeminiTtsOptions): Promise<Buffer> {
  const voice = GEMINI_VOICES[opts.voice];

  debugReq('[%s] voice=%s lang=%s %d chars', GEMINI_TTS_MODEL, voice, opts.language, opts.text.length);
  const t0 = Date.now();

  const client = getGeminiClient();
  const response = await client.models.generateContent({
    model: GEMINI_TTS_MODEL,
    contents: GEMINI_STYLE_PROMPT + opts.text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const data = part?.inlineData?.data;
  if (!data) {
    throw new Error('Gemini-TTS returned no audio content');
  }

  const pcm = Buffer.from(data, 'base64');
  const buf = pcmToWav(pcm, rateFromMime(part.inlineData?.mimeType));
  debugAgent('[%s] %ds', GEMINI_TTS_MODEL, Math.round((Date.now() - t0) / 1000));
  debugRes('[%s] %sKB audio', GEMINI_TTS_MODEL, (buf.length / 1024).toFixed(0));
  return buf;
}
