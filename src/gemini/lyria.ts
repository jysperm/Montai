import createDebug from 'debug';
import { getGeminiClient } from './client.js';

// Lyria 3 Clip via the Gemini Developer API (Interactions API). Returns ~30s
// clips, authenticated by GEMINI_API_KEY alone. Same value as the
// `models.musicGeneration` option that selects this provider.
const LYRIA_MODEL = 'lyria-3-clip-preview';

// Lyria 3 generates vocals/lyrics by default; this pins it to instrumental so
// generated tracks stay usable as background music.
const INSTRUMENTAL_DIRECTIVE = 'Instrumental only, no vocals.';

const debugAgent = createDebug('montai:agent');
const debugReq = createDebug('montai:req');
const debugReqVerbose = createDebug('montai:req:verbose');
const debugRes = createDebug('montai:res');

export interface LyriaResult {
  buffer: Buffer;
  /** File extension implied by the returned audio's mime type (e.g. 'mp3'). */
  extension: string;
}

function extensionForMime(mimeType: string | undefined): string {
  if (mimeType?.includes('wav')) return 'wav';
  if (mimeType?.includes('mp3') || mimeType?.includes('mpeg')) return 'mp3';
  return 'mp3'; // Lyria 3 Clip returns MP3 by default
}

/**
 * Generate an instrumental music clip via Lyria 3 (~30s).
 * Requires GEMINI_API_KEY.
 */
export async function callLyria(prompt: string): Promise<LyriaResult> {
  const input = `${prompt.trim()}\n\n${INSTRUMENTAL_DIRECTIVE}`;

  const trimmed = prompt.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0];
  const moreCount = lines.length - 1;
  debugReq('[%s] %s', LYRIA_MODEL, moreCount > 0 ? `${firstLine} ... (${moreCount} more lines)` : firstLine);
  if (moreCount > 0 && debugReqVerbose.enabled) {
    debugReqVerbose('[%s] %s', LYRIA_MODEL, lines.slice(1).join('\n').trim());
  }
  const t0 = Date.now();

  const client = getGeminiClient();
  const interaction = await client.interactions.create({
    model: LYRIA_MODEL,
    input,
  });

  if (interaction.status !== 'completed') {
    throw new Error(`Lyria interaction did not complete (status: ${interaction.status})`);
  }

  const audio = interaction.output_audio;
  if (!audio?.data) {
    throw new Error('Lyria interaction returned no audio content');
  }

  const buffer = Buffer.from(audio.data, 'base64');
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
  debugAgent('[%s] %ds', LYRIA_MODEL, Math.round((Date.now() - t0) / 1000));
  debugRes('[%s] %sMB audio (%s)', LYRIA_MODEL, sizeMB, audio.mime_type);

  return { buffer, extension: extensionForMime(audio.mime_type) };
}
