import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { eq } from 'drizzle-orm';
import type { FileContent, Message } from '@mariozechner/pi-ai';
import { getGeminiModel } from '../gemini/models.js';
import { analysisSignature, provenanceFor, renderAnalysisPrompt } from '../analyzer/provenance.js';
import createDebug from 'debug';
import type { MontaiDb } from '../db/index.js';
import { voiceovers, voiceoverAnalyses } from '../db/schema.js';
import { resolveVoiceLanguage, type ProjectConfig } from '../schemas/project.js';
import { getAudioMetadata } from '../utils/ffprobe.js';
import { callGeminiTts, geminiTtsSignature } from '../gemini/tts.js';
import { uploadFileToGemini } from '../gemini/upload.js';
import { completeWithSchemaRetry } from '../analyzer/utils.js';
import { VoiceoverAnalysisSchema } from '../schemas/analysis.js';

export type VoiceoverProvider = 'gemini-2.5-flash-preview-tts' | 'system';
// Coarse voice descriptor. Only female/male today; extensible to styles like
// 'elderly' or 'child' later without changing the surrounding plumbing.
export type VoiceStyle = 'female' | 'male';

const GENERATED_VOICEOVER_DIR = 'generated-voiceover';

// macOS `say` voices per language. Male entries are optional — some languages
// (e.g. Mandarin) ship no reliable default male voice, so we fall back to female.
const SAY_VOICES: Record<string, { female: string; male?: string }> = {
  zh: { female: 'Tingting' },
  ja: { female: 'Kyoko', male: 'Otoya' },
  en: { female: 'Samantha', male: 'Alex' },
};

const debugAgent = createDebug('montai:agent');
const debugReq = createDebug('montai:req');
const debugRes = createDebug('montai:res');

export interface GeneratedVoiceover {
  voiceover: typeof voiceovers.$inferSelect;
  analysis: typeof voiceoverAnalyses.$inferSelect;
}

interface SynthesizeOptions {
  provider: VoiceoverProvider;
  text: string;
  voice: VoiceStyle;
  language: string;
}

function cacheHash(text: string, signature: string): string {
  return createHash('sha256').update([text, signature].join(' ')).digest('hex').slice(0, 16);
}

/** Synthesize narration audio with the configured provider and return a WAV buffer. */
async function synthesizeVoiceover(opts: SynthesizeOptions): Promise<Buffer> {
  if (opts.provider === 'system') {
    return synthesizeWithSay(opts);
  }
  return callGeminiTts(opts);
}

/**
 * Everything besides the script that shapes the audio, so the cache key covers it —
 * changing the voice or the provider must invalidate old tracks.
 */
function synthesisSignature(opts: Omit<SynthesizeOptions, 'text'>): string {
  if (opts.provider === 'system') {
    return ['system', opts.language, opts.voice].join(':');
  }
  return geminiTtsSignature(opts);
}

/**
 * macOS `say`: synthesize to AIFF, then convert to WAV with ffmpeg.
 * Offline and free, but robotic and without timestamps (filled in by analysis).
 */
function synthesizeWithSay(opts: SynthesizeOptions): Buffer {
  const langVoices = SAY_VOICES[opts.language];
  const voice = langVoices
    ? (opts.voice === 'male' ? (langVoices.male ?? langVoices.female) : langVoices.female)
    : undefined;
  const workDir = mkdtempSync(join(tmpdir(), 'montai-say-'));
  const aiffPath = join(workDir, 'out.aiff');
  const wavPath = join(workDir, 'out.wav');

  debugReq('[say] voice=%s %d chars', voice ?? 'default', opts.text.length);
  const t0 = Date.now();

  try {
    const sayArgs = ['-o', aiffPath];
    if (voice) sayArgs.push('-v', voice);
    sayArgs.push(opts.text);
    execFileSync('say', sayArgs);

    execFileSync('ffmpeg', ['-y', '-i', aiffPath, wavPath], { stdio: ['ignore', 'ignore', 'pipe'] });

    const buf = readFileSync(wavPath);
    debugAgent('[say] %ds', Math.round((Date.now() - t0) / 1000));
    debugRes('[say] %sKB audio', (buf.length / 1024).toFixed(0));
    return buf;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Synthesize narration audio via TTS (or reuse a cached track), then transcribe
 * it in place so the generated voiceover carries the same timestamped
 * transcription as a library recording. Inserts into the voiceovers table with
 * type='generated'. Mirrors ./music.ts, with an added analysis step.
 */
export async function generateVoiceoverTrack(
  db: MontaiDb,
  config: ProjectConfig,
  params: { text: string; voice?: VoiceStyle },
): Promise<GeneratedVoiceover> {
  const provider = config.models.voiceoverGeneration as VoiceoverProvider | undefined;
  if (!provider) {
    throw new Error('models.voiceoverGeneration is not configured.');
  }

  const language = resolveVoiceLanguage(config);
  const voice = params.voice ?? 'female';
  const hash = cacheHash(params.text, synthesisSignature({ provider, voice, language }));
  const cachePath = resolve(GENERATED_VOICEOVER_DIR, `${hash}.wav`);

  // Reuse a fully materialized track (row + transcription) when the same
  // text/voice/language/provider was generated before and the file still exists.
  const existing = db.select().from(voiceovers).where(eq(voiceovers.md5, hash)).get();
  if (existing && existsSync(existing.path)) {
    const existingAnalysis = db
      .select()
      .from(voiceoverAnalyses)
      .where(eq(voiceoverAnalyses.voiceoverId, existing.id))
      .get();
    if (existingAnalysis) {
      return { voiceover: existing, analysis: existingAnalysis };
    }
  }

  // Materialize the audio file: reuse a cached file (e.g. after a DB reset) or synthesize.
  if (!existsSync(cachePath)) {
    mkdirSync(GENERATED_VOICEOVER_DIR, { recursive: true });
    const wavBuffer = await synthesizeVoiceover({ provider, text: params.text, voice, language });
    const tmpPath = cachePath.replace(/\.wav$/, '.tmp.wav');
    writeFileSync(tmpPath, wavBuffer);
    renameSync(tmpPath, cachePath);
  }

  const meta = getAudioMetadata(cachePath);

  const voiceover = existing ?? db
    .insert(voiceovers)
    .values({
      filename: basename(cachePath),
      path: cachePath,
      md5: hash,
      type: 'generated',
      generationText: params.text,
      durationSeconds: meta.durationSeconds,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
    })
    .returning()
    .get();

  // Transcribe the generated audio through the same analysis prompt as library
  // voiceovers, so timestamps come uniformly from Gemini (works for `system` too).
  const analysis = await transcribeGeneratedVoiceover(db, config, voiceover.id, cachePath);

  return { voiceover, analysis };
}

async function transcribeGeneratedVoiceover(
  db: MontaiDb,
  config: ProjectConfig,
  voiceoverId: number,
  path: string,
): Promise<typeof voiceoverAnalyses.$inferSelect> {
  const model = getGeminiModel(config.models.analysis);
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const uploaded = await uploadFileToGemini(path);
  const fileContent: FileContent = { type: 'file', uri: uploaded.fileUri, mimeType: 'audio/wav' };
  const prompt = renderAnalysisPrompt(config, 'voiceover');
  const messages: Message[] = [
    { role: 'user', content: [fileContent, { type: 'text', text: prompt }], timestamp: Date.now() },
  ];

  const result = await completeWithSchemaRetry({
    model,
    messages,
    apiKey,
    schema: VoiceoverAnalysisSchema,
    maxRetries: 2,
  });
  if (result.finalError) {
    throw new Error(`voiceover transcription failed: ${result.finalError}`);
  }

  const fields = {
    overview: String(result.raw.overview ?? ''),
    transcription: JSON.stringify(result.raw.transcription ?? []),
    ...provenanceFor(analysisSignature(config, 'voiceover', model.id)),
  };

  const existing = db.select().from(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, voiceoverId)).get();
  if (existing) {
    db.update(voiceoverAnalyses).set(fields).where(eq(voiceoverAnalyses.voiceoverId, voiceoverId)).run();
  } else {
    db.insert(voiceoverAnalyses).values({ voiceoverId, ...fields }).run();
  }

  return db.select().from(voiceoverAnalyses).where(eq(voiceoverAnalyses.voiceoverId, voiceoverId)).get()!;
}
