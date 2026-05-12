import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { closeDbForTests, initDb, type MontaiDb } from '../../src/db/index.js';
import { getStoryTools, type StoryToolsContext } from '../../src/agents/story-tools.js';

const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY);
const sampleVideo = '/Users/jysperm/Movies/2026-02 Chiang Mai Flower Festival/footage/DJI_20260214191551_0020_D.MP4';

function createContext(db: MontaiDb, videoId: number, storyName: string): StoryToolsContext {
  return {
    db,
    config: {
      assets: { videos: ['.'], music: [], voiceover: [] },
      language: 'en',
      output: { resolution: '720p', fps: 10 },
      models: { analysis: 'gemini-3-flash-preview', editing: 'gemini-3.1-pro-preview' },
      effects: { languages: ['en'] },
      featureFlags: {},
    },
    allVideos: [{ id: videoId, path: sampleVideo, filename: 'sample.MP4', durationSeconds: 4 }],
    allVideoAnalyses: [],
    allMusic: [],
    allMusicAnalyses: [],
    allVoiceovers: [],
    allVoiceoverAnalyses: [],
    currentStoryId: null,
    currentStoryName: null,
    currentItems: [],
    agent: null,
    languageName: 'English',
    overlayLanguageNames: 'English',
    features: { music: false, musicGeneration: false, voiceover: false, previewTools: true },
    timelineVersion: 0,
    sessionId: 0,
  };
}

function seedStoryWithClips(ctx: StoryToolsContext, videoId: number, storyName: string) {
  const now = new Date().toISOString();
  ctx.db.insert(schema.videos).values({
    id: videoId,
    filename: 'sample.MP4',
    path: sampleVideo,
    md5: `test-${videoId}`,
    durationSeconds: 4,
    width: 1280,
    height: 720,
    fpsNum: 30,
    fpsDen: 1,
    fps: '30',
    totalFrames: 120,
    audioChannels: 2,
    audioSampleRate: 48000,
  }).run();

  const result = ctx.db.insert(schema.stories).values({
    name: storyName,
    title: 'Preview Integration Test',
    storyline: 's',
    timeline: JSON.stringify([
      { type: 'clip', videoId, startTimeSeconds: 0, endTimeSeconds: 1 },
      { type: 'clip', videoId, startTimeSeconds: 1, endTimeSeconds: 2 },
    ]),
    createdAt: now,
    updatedAt: now,
  }).returning().get();

  ctx.currentStoryId = result.id;
  ctx.currentStoryName = storyName;
}

describe.skipIf(!hasGeminiKey)('preview tools integration', () => {
  let db: MontaiDb;
  let tempDir: string;
  let videoId: number;
  let storyName: string;

  beforeAll(async () => {
    if (!existsSync(sampleVideo)) {
      throw new Error(`Sample video not found: ${sampleVideo}`);
    }

    tempDir = mkdtempSync(resolve('.montai/preview-tools-test-'));
    db = await initDb(resolve(tempDir, 'montai.db'));
    videoId = Math.floor(Date.now() % 1_000_000_000);
    storyName = `preview-integration-${videoId}`;
  });

  afterAll(() => {
    closeDbForTests();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs watchSegment transcode/upload and preview render/upload on a short sample', async () => {
    const ctx = createContext(db, videoId, storyName);
    seedStoryWithClips(ctx, videoId, storyName);
    const { tools } = getStoryTools(ctx);

    const watchSegment = tools.find((t) => t.name === 'watchSegment')!;
    const previewFrame = tools.find((t) => t.name === 'previewFrame')!;
    const previewFinalVideo = tools.find((t) => t.name === 'previewFinalVideo')!;

    const watched = await watchSegment.execute('watch-1', {
      videoId,
      startSeconds: 0,
      endSeconds: 1,
      fps: 1,
    });
    expect(watched.isError).toBeFalsy();
    expect(watched.content[1].type).toBe('file');
    expect(watched.content[1].uri).toBeTruthy();
    expect(watched.content[1].uri).not.toMatch(/^gemini:\/\/stub\//);
    expect(existsSync(resolve('.montai/transcoded', `${videoId}.mp4`))).toBe(true);

    const frame = await previewFrame.execute('frame-1', { clipIndex: 0, timeOffset: 0.25 });
    expect(frame.isError, frame.content[0]?.text).toBeFalsy();
    expect(frame.content[1].type).toBe('image');
    expect(frame.content[1].mimeType).toBe('image/png');
    expect(Buffer.from(frame.content[1].data, 'base64').subarray(0, 8))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const preview = await previewFinalVideo.execute('preview-1', {
      startSeconds: 0,
      endSeconds: 1,
      fps: 1,
    });
    expect(preview.isError, preview.content[0]?.text).toBeFalsy();
    expect(preview.content[1].type).toBe('file');
    expect(preview.content[1].mimeType).toBe('video/mp4');
    expect(preview.content[1].uri).toBeTruthy();
    expect(preview.content[1].uri).not.toMatch(/^gemini:\/\/stub\//);

    const uploadRows = db.all(sql`select cache_key from gemini_files`) as { cache_key: string | null }[];
    expect(uploadRows.some((r) => r.cache_key?.endsWith(`${videoId}.mp4`))).toBe(true);
    expect(uploadRows.some((r) => r.cache_key?.startsWith('.montai/.cache/previews/') && r.cache_key.endsWith('.mp4'))).toBe(true);
    expect(readdirSync(resolve('.montai/.cache/previews')).some((f) => statSync(resolve('.montai/.cache/previews', f)).size > 0)).toBe(true);
  }, 300_000);
});
