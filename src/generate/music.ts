import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { eq } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { music } from '../db/schema.js';
import { getAudioMetadata } from '../utils/ffprobe.js';
import { callLyria } from '../gemini/lyria.js';

const GENERATED_MUSIC_DIR = 'generated-music';

function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/**
 * Generate a music track via Lyria 3 (or return cached).
 * Inserts into the music table with type='generated'.
 */
export async function generateMusicTrack(
  db: MontaiDb,
  prompt: string,
): Promise<{ musicId: number; path: string; durationSeconds: number }> {
  // Check DB for existing generated track with same prompt
  const existing = db
    .select()
    .from(music)
    .where(eq(music.generationPrompt, prompt))
    .get();

  if (existing && existsSync(existing.path)) {
    return {
      musicId: existing.id,
      path: existing.path,
      durationSeconds: existing.durationSeconds ?? 30,
    };
  }

  // Check file cache (file exists but DB row missing — e.g. after DB reset).
  // The extension depends on what Lyria returned, so match on the hash prefix.
  const hash = promptHash(prompt);
  const cached = existsSync(GENERATED_MUSIC_DIR)
    ? readdirSync(GENERATED_MUSIC_DIR).find((f) => f.startsWith(`${hash}.`) && !f.includes('.tmp.'))
    : undefined;

  if (cached) {
    const cachePath = resolve(GENERATED_MUSIC_DIR, cached);
    const meta = getAudioMetadata(cachePath);
    const row = db
      .insert(music)
      .values({
        filename: basename(cachePath),
        path: cachePath,
        md5: hash,
        type: 'generated',
        generationPrompt: prompt,
        durationSeconds: meta.durationSeconds,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
      })
      .returning()
      .get();
    return { musicId: row.id, path: cachePath, durationSeconds: meta.durationSeconds };
  }

  // Generate via Lyria 3
  mkdirSync(GENERATED_MUSIC_DIR, { recursive: true });
  const { buffer, extension } = await callLyria(prompt);
  const cachePath = resolve(GENERATED_MUSIC_DIR, `${hash}.${extension}`);

  // Atomic write
  const tmpPath = resolve(GENERATED_MUSIC_DIR, `${hash}.tmp.${extension}`);
  writeFileSync(tmpPath, buffer);
  renameSync(tmpPath, cachePath);

  // Probe metadata
  const meta = getAudioMetadata(cachePath);

  // Insert into DB
  const row = db
    .insert(music)
    .values({
      filename: basename(cachePath),
      path: cachePath,
      md5: hash,
      type: 'generated',
      generationPrompt: prompt,
      durationSeconds: meta.durationSeconds,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
    })
    .returning()
    .get();

  return { musicId: row.id, path: cachePath, durationSeconds: meta.durationSeconds };
}
