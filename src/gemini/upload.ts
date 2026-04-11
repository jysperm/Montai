import { getGeminiClient } from './client.js';
import { getDb } from '../db/index.js';
import { geminiFiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const EXPIRY_HOURS = 48;

async function uploadAndWait(filePath: string): Promise<string> {
  const client = getGeminiClient();
  const uploadResult = await client.files.upload({
    file: filePath,
  });

  if (!uploadResult.uri) {
    throw new Error(`Failed to upload file: ${filePath}`);
  }

  let fileState = uploadResult.state ?? 'PROCESSING';
  let fileUri = uploadResult.uri;

  while (fileState === 'PROCESSING') {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const fileInfo = await client.files.get({ name: uploadResult.name! });
    fileState = fileInfo.state ?? 'FAILED';
    fileUri = fileInfo.uri ?? fileUri;

    if (fileState !== 'PROCESSING' && fileState !== 'ACTIVE') {
      const errorMsg = fileInfo.error?.message ?? 'unknown error';
      throw new Error(`File processing failed (state: ${fileState}): ${errorMsg}`);
    }
  }

  return fileUri;
}

export async function uploadVideoToGemini(
  videoId: number,
  transcodedPath: string
): Promise<string> {
  const db = getDb();

  const cached = db
    .select()
    .from(geminiFiles)
    .where(eq(geminiFiles.videoId, videoId))
    .get();

  if (cached && cached.state === 'ACTIVE') {
    const uploadedAt = new Date(cached.uploadedAt);
    const hoursAgo = (Date.now() - uploadedAt.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < EXPIRY_HOURS) {
      return cached.fileUri;
    }
  }

  const fileUri = await uploadAndWait(transcodedPath);

  if (cached) {
    db.update(geminiFiles)
      .set({
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .where(eq(geminiFiles.id, cached.id))
      .run();
  } else {
    db.insert(geminiFiles)
      .values({
        videoId,
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .run();
  }

  return fileUri;
}

export async function uploadMusicToGemini(
  musicId: number,
  filePath: string
): Promise<string> {
  const db = getDb();

  const cached = db
    .select()
    .from(geminiFiles)
    .where(eq(geminiFiles.musicId, musicId))
    .get();

  if (cached && cached.state === 'ACTIVE') {
    const uploadedAt = new Date(cached.uploadedAt);
    const hoursAgo = (Date.now() - uploadedAt.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < EXPIRY_HOURS) {
      return cached.fileUri;
    }
  }

  const fileUri = await uploadAndWait(filePath);

  if (cached) {
    db.update(geminiFiles)
      .set({
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .where(eq(geminiFiles.id, cached.id))
      .run();
  } else {
    db.insert(geminiFiles)
      .values({
        musicId,
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .run();
  }

  return fileUri;
}

export async function uploadVoiceoverToGemini(
  voiceoverId: number,
  filePath: string
): Promise<string> {
  const db = getDb();

  const cached = db
    .select()
    .from(geminiFiles)
    .where(eq(geminiFiles.voiceoverId, voiceoverId))
    .get();

  if (cached && cached.state === 'ACTIVE') {
    const uploadedAt = new Date(cached.uploadedAt);
    const hoursAgo = (Date.now() - uploadedAt.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < EXPIRY_HOURS) {
      return cached.fileUri;
    }
  }

  const fileUri = await uploadAndWait(filePath);

  if (cached) {
    db.update(geminiFiles)
      .set({
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .where(eq(geminiFiles.id, cached.id))
      .run();
  } else {
    db.insert(geminiFiles)
      .values({
        voiceoverId,
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .run();
  }

  return fileUri;
}
