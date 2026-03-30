import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema.js';
import { getStoryTools, type StoryToolsContext } from '../../src/commands/tools.js';
import type { TimelineItem } from '../../src/schemas/timeline-items.js';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      storyline TEXT,
      timeline TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

function createContext(db: ReturnType<typeof createTestDb>): StoryToolsContext {
  return {
    db: db as any,
    config: {
      assets: { videos: ['.'], music: [] },
      language: 'en' as const,
      output: { resolution: '1080p' as const, fps: 50 },
      models: { analysis: 'gemini-3-flash-preview', editing: 'gemini-3-pro-preview' },
      effects: { languages: ['en'] },
    },
    allVideos: [{ id: 1, path: '/test/video1.mp4', filename: 'video1.mp4' }],
    allSummaries: [],
    allMusic: [{ id: 1, filename: 'test.mp3', path: '/test/test.mp3', md5: 'abc', type: 'library', generationPrompt: null, durationSeconds: 30, sampleRate: 44100, channels: 2 }],
    allMusicSummaries: [],
    currentStoryId: null,
    currentStoryName: null,
    currentItems: [],
  };
}

function seedStory(ctx: StoryToolsContext) {
  const now = new Date().toISOString();
  const result = (ctx.db as any).insert(schema.stories).values({
    name: 'test',
    title: 'Test Story',
    storyline: 'test',
    createdAt: now,
    updatedAt: now,
  }).returning().get();
  ctx.currentStoryId = result.id;
  ctx.currentStoryName = 'test';
}

describe('updateTimeline post-processing', () => {
  let ctx: StoryToolsContext;
  let updateTimeline: { execute: (id: string, params: any) => Promise<any> };

  beforeEach(async () => {
    const db = createTestDb();
    ctx = createContext(db);
    seedStory(ctx);
    const { tools } = getStoryTools(ctx);
    updateTimeline = tools.find((t) => t.name === 'updateTimeline')!;

    // Seed 2 clips so overlay/audio tests have valid clip targets
    await updateTimeline.execute('setup', {
      index: 0,
      deleteCount: -1,
      items: [
        { type: 'clip', videoId: 1, startTimeSeconds: 0, endTimeSeconds: 10 },
        { type: 'clip', videoId: 1, startTimeSeconds: 10, endTimeSeconds: 20 },
      ],
    });
  });

  it('returns no corrections for valid items', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'overlay', text: 'Hello', startClip: 0, endClip: 1, position: 'bottom-center', style: 'subtitle' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Timeline updated');
    expect(result.content[0].text).not.toContain('Corrections');
  });

  it('clamps out-of-range clip indices for audio and overlay', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'audio', startClip: 0, endClip: 5, musicId: 1, volume: 0.5 },
        { type: 'overlay', text: 'Late subtitle', startClip: 9, endClip: 9, position: 'bottom-center', style: 'subtitle' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Corrections applied');
    expect(result.content[0].text).toContain('endClip clamped from 5 to 1');
    expect(result.content[0].text).toContain('startClip clamped from 9 to 1');

    const audioItem = ctx.currentItems.find((i): i is Extract<TimelineItem, { type: 'audio' }> => i.type === 'audio')!;
    expect(audioItem.endClip).toBe(1);

    const overlayItem = ctx.currentItems.find((i): i is Extract<TimelineItem, { type: 'overlay' }> => i.type === 'overlay')!;
    expect(overlayItem.startClip).toBe(1);
    expect(overlayItem.endClip).toBe(1);
  });

  it('fixes escaped newlines in overlay text', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'overlay', text: 'Line 1\\nLine 2', startClip: 0, position: 'bottom-center', style: 'subtitle' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Corrections applied');
    expect(result.content[0].text).toContain('escaped \\\\n replaced with newline');

    const overlayItem = ctx.currentItems.find((i): i is Extract<TimelineItem, { type: 'overlay' }> => i.type === 'overlay')!;
    expect(overlayItem.text).toBe('Line 1\nLine 2');
  });
});
