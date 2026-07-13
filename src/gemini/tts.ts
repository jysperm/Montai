import { GoogleAuth } from 'google-auth-library';
import createDebug from 'debug';
import type { VoiceStyle } from '../generate/tts.js';

// The GA Gemini-TTS model exposed through the Cloud Text-to-Speech API. Same
// value as the `models.voiceoverGeneration` option that selects this provider.
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-tts';

// Cloud TTS voice.languageCode by project language. Gemini-TTS also
// auto-detects language from the script, but the API still requires a code.
const GEMINI_LANGUAGE_CODES: Record<string, string> = {
  zh: 'cmn-CN',
  ja: 'ja-JP',
  en: 'en-US',
};

// Gemini-TTS prebuilt voices per style. Language-independent. Picked for a warm,
// conversational delivery — the "Firm" voices read as flat newsreader narration.
const GEMINI_VOICES: Record<VoiceStyle, string> = {
  female: 'Aoede',
  male: 'Puck',
};

// Gemini-TTS ignores audioConfig.speakingRate/pitch, so pacing and tone are only
// steerable through this prompt. Its default delivery is slow and flat.
const GEMINI_STYLE_PROMPT = 'Read the following in a natural, conversational tone, at a slightly faster pace.';

const debugAgent = createDebug('montai:agent');
const debugReq = createDebug('montai:req');
const debugRes = createDebug('montai:res');

interface GeminiTtsResponse {
  audioContent?: string;
}

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
    GEMINI_LANGUAGE_CODES[opts.language] ?? 'en-US',
    GEMINI_VOICES[opts.voice],
    GEMINI_STYLE_PROMPT,
  ].join(':');
}

/**
 * Google Gemini-TTS via the Cloud Text-to-Speech `:synthesize` endpoint.
 * Shares authentication with Lyria (GOOGLE_CLOUD_PROJECT + ADC); LINEAR16
 * output is returned as a complete WAV.
 */
export async function callGeminiTts(opts: GeminiTtsOptions): Promise<Buffer> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    throw new Error(
      'GOOGLE_CLOUD_PROJECT environment variable is required for voiceover generation.\n' +
      'Set up Google Cloud credentials:\n' +
      '  1. gcloud auth application-default login\n' +
      '  2. export GOOGLE_CLOUD_PROJECT=your-project-id',
    );
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  let accessToken: string | null | undefined;
  try {
    const client = await auth.getClient();
    accessToken = (await client.getAccessToken()).token;
  } catch (err) {
    throw new Error(
      `Failed to get Google Cloud credentials. Run: gcloud auth application-default login\n` +
      `Original error: ${err instanceof Error ? err.message : err}`,
    );
  }

  const languageCode = GEMINI_LANGUAGE_CODES[opts.language] ?? 'en-US';
  const voice = GEMINI_VOICES[opts.voice];

  const body = {
    input: { text: opts.text, prompt: GEMINI_STYLE_PROMPT },
    voice: { languageCode, name: voice, modelName: GEMINI_TTS_MODEL },
    audioConfig: { audioEncoding: 'LINEAR16' },
  };

  debugReq('[%s] voice=%s lang=%s %d chars', GEMINI_TTS_MODEL, voice, languageCode, opts.text.length);
  const t0 = Date.now();

  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': project,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini-TTS API error (${response.status}): ${errText}`);
  }

  const data = await response.json() as GeminiTtsResponse;
  if (!data.audioContent) {
    throw new Error('Gemini-TTS API returned no audio content');
  }

  const buf = Buffer.from(data.audioContent, 'base64');
  debugAgent('[%s] %ds', GEMINI_TTS_MODEL, Math.round((Date.now() - t0) / 1000));
  debugRes('[%s] %sKB audio', GEMINI_TTS_MODEL, (buf.length / 1024).toFixed(0));
  return buf;
}
