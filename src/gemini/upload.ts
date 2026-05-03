import { relative, resolve } from 'path';
import { getGeminiClient } from './client.js';
import { getDb } from '../db/index.js';
import { geminiFiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const EXPIRY_HOURS = 48;

export type UploadResult = { fileUri: string; cached: boolean };

function isWithinExpiry(uploadedAt: string): boolean {
  const hoursAgo = (Date.now() - new Date(uploadedAt).getTime()) / (1000 * 60 * 60);
  return hoursAgo < EXPIRY_HOURS;
}

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

// Single upload entry point for all Gemini File API uploads (source video
// transcodes, music / voiceover assets, previewFinalVideo renders). The cache
// key is the project-relative file path, which is unique across all use cases:
//   - .montai/transcoded/<id>-<n>fps.mp4   (source video)
//   - musics/<file>                         (music asset, user-supplied)
//   - voiceover/<file>                      (voiceover asset, user-supplied)
//   - .montai/.cache/previews/<sha256>.mp4 (previewFinalVideo render)
// Reuses an active+fresh upload for the same path; otherwise uploads and
// upserts the row.
export async function uploadFileToGemini(filePath: string): Promise<UploadResult> {
  const db = getDb();
  const cacheKey = relative(process.cwd(), resolve(filePath));

  const cached = db
    .select()
    .from(geminiFiles)
    .where(eq(geminiFiles.cacheKey, cacheKey))
    .get();

  if (cached && cached.state === 'ACTIVE' && isWithinExpiry(cached.uploadedAt)) {
    return { fileUri: cached.fileUri, cached: true };
  }

  const fileUri = await uploadAndWait(filePath);
  const uploadedAt = new Date().toISOString();

  if (cached) {
    db.update(geminiFiles)
      .set({ fileUri, uploadedAt, state: 'ACTIVE' })
      .where(eq(geminiFiles.id, cached.id))
      .run();
  } else {
    db.insert(geminiFiles)
      .values({ cacheKey, fileUri, uploadedAt, state: 'ACTIVE' })
      .run();
  }

  return { fileUri, cached: false };
}
