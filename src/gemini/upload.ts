import { getGeminiClient } from './client.js';
import { getDb } from '../db/index.js';
import { geminiFiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const EXPIRY_HOURS = 48;

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

  const client = getGeminiClient();
  const uploadResult = await client.files.upload({
    file: transcodedPath,
  });

  if (!uploadResult.uri) {
    throw new Error(`Failed to upload file: ${transcodedPath}`);
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

  if (cached) {
    db.update(geminiFiles)
      .set({
        fileUri,
        uploadedAt: new Date().toISOString(),
        state: 'ACTIVE',
      })
      .where(eq(geminiFiles.videoId, videoId))
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
