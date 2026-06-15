import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema.js';
import { getStoryTools, type StoryToolsContext } from '../../src/agents/story-tools.js';
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
  sqlite.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      current_story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE
    )
  `);
  return drizzle(sqlite, { schema });
}

function createContext(db: ReturnType<typeof createTestDb>): StoryToolsContext {
  return {
    db: db as any,
    config: {
      assets: { videos: ['.'], music: [], voiceover: [] },
      language: 'en' as const,
      output: { resolution: '1080p' as const, fps: 50 },
      models: { analysis: 'gemini-3.5-flash', editing: 'gemini-3.5-flash' },
      effects: { languages: ['en'] },
      featureFlags: {},
    },
    allVideos: [
      { id: 1, path: '/test/video1.mp4', filename: 'video1.mp4' },
      { id: 2, path: '/test/video2.mp4', filename: 'video2.mp4' },
    ],
    allVideoAnalyses: [],
    allMusic: [{ id: 1, filename: 'test.mp3', path: '/test/test.mp3', md5: 'abc', type: 'library', generationPrompt: null, durationSeconds: 30, sampleRate: 44100, channels: 2 }],
    allMusicAnalyses: [],
    allVoiceovers: [],
    allVoiceoverAnalyses: [],
    currentStoryId: null,
    currentStoryName: null,
    currentItems: [],
    agent: null,
    timelineVersion: 0,
    sessionId: 0,
    languageName: 'English',
    overlayLanguageNames: 'English',
    features: { music: true, musicGeneration: false, voiceover: false, previewTools: true },
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

describe('updateStoryline tool', () => {
  it('keeps the existing name and title when omitted', async () => {
    const db = createTestDb();
    const ctx = createContext(db);
    seedStory(ctx);
    const { tools } = getStoryTools(ctx);
    const updateStoryline = tools.find((t) => t.name === 'updateStoryline')!;

    await updateStoryline.execute('call-1', {
      brief: 'updated brief',
    });

    const row = (ctx.db as any).select().from(schema.stories).get();
    expect(row.name).toBe('test');
    expect(row.title).toBe('Test Story');
    expect(row.storyline).toBe('updated brief');
  });

  it('requires title when creating a new story', async () => {
    const db = createTestDb();
    const ctx = createContext(db);
    const { tools } = getStoryTools(ctx);
    const updateStoryline = tools.find((t) => t.name === 'updateStoryline')!;

    await expect(updateStoryline.execute('call-1', {
      name: 'new-story',
      brief: 'new brief',
    })).rejects.toThrow(/title is required/);
  });
});

describe('updateTimeline tool', () => {
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
        { type: 'clip', videoId: 1, startTime: '00:00', endTime: '00:10' },
        { type: 'clip', videoId: 1, startTime: '00:10', endTime: '00:20' },
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

  it('stores clip start/end timestamps with the new field names', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 0,
      deleteCount: -1,
      items: [
        { type: 'clip', videoId: 1, startTime: '01:05', endTime: '01:12.5' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const row = (ctx.db as any).select().from(schema.stories).get();
    const stored = JSON.parse(row.timeline);
    expect(stored[0]).toMatchObject({ type: 'clip', videoId: 1, startTime: '01:05', endTime: '01:12.5' });
    expect(stored[0]).not.toHaveProperty('startTimeSeconds');
    expect(stored[0]).not.toHaveProperty('endTimeSeconds');
  });

  it('normalizes legacy clip seconds when saving', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 0,
      deleteCount: -1,
      items: [
        { type: 'clip', videoId: 1, startTimeSeconds: 65, endTimeSeconds: 72.5 },
      ],
    });

    expect(result.isError).toBeUndefined();
    const row = (ctx.db as any).select().from(schema.stories).get();
    const stored = JSON.parse(row.timeline);
    expect(stored[0]).toMatchObject({ type: 'clip', videoId: 1, startTime: '01:05', endTime: '01:12.5' });
    expect(stored[0]).not.toHaveProperty('startTimeSeconds');
    expect(stored[0]).not.toHaveProperty('endTimeSeconds');
  });

  it('rejects clips where endTime is not after startTime', async () => {
    await expect(updateTimeline.execute('call-1', {
      index: 0,
      deleteCount: -1,
      items: [
        { type: 'clip', videoId: 1, startTime: '00:10', endTime: '00:10' },
      ],
    })).rejects.toThrow(/endTime \(00:10\) must be greater than startTime \(00:10\)/);
  });

  it('clamps out-of-range clip indices for audio and overlay', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'music', startClip: 0, endClip: 5, musicId: 1, volume: 0.5 },
        { type: 'overlay', text: 'Late subtitle', startClip: 9, endClip: 9, position: 'bottom-center', style: 'subtitle' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Corrections applied');
    expect(result.content[0].text).toContain('endClip clamped from 5 to 1');
    expect(result.content[0].text).toContain('startClip clamped from 9 to 1');

    const musicItem = ctx.currentItems.find((i): i is Extract<TimelineItem, { type: 'music' }> => i.type === 'music')!;
    expect(musicItem.endClip).toBe(1);

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

  it('removes clips referencing missing videos', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'clip', videoId: 999, startTime: '00:00', endTime: '00:10' },
      ],
    });
    expect(result.content[0].text).toContain('videoId=999');
    expect(ctx.currentItems.filter(i => i.type === 'clip')).toHaveLength(2); // only the original 2
  });

  it('removes audio referencing missing music', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'music', startClip: 0, musicId: 999, volume: 0.5 },
      ],
    });
    expect(result.content[0].text).toContain('musicId=999');
    expect(ctx.currentItems.filter(i => i.type === 'music')).toHaveLength(0);
  });

  it('wraps legacy music audioStartSeconds into the source duration', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'music', startClip: 0, endClip: 1, musicId: 1, audioStartSeconds: 43, volume: 0.3 },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('startTime 00:43 exceeds music duration 00:30');
    expect(result.content[0].text).toContain('set to 00:13');
    expect(result.content[0].text).toContain('startTime=00:13, endTime=00:33');

    const musicItem = ctx.currentItems.find((i): i is Extract<TimelineItem, { type: 'music' }> => i.type === 'music')!;
    expect(musicItem.startTime).toBe('00:13');
  });

});

describe('updateTimeline auto-loop', () => {
  let ctx: StoryToolsContext;
  let updateTimeline: { execute: (id: string, params: any) => Promise<any> };

  beforeEach(async () => {
    const db = createTestDb();
    ctx = createContext(db);
    // Use short 5s music for loop tests
    ctx.allMusic = [{ id: 1, filename: 'short.mp3', path: '/test/short.mp3', md5: 'x', type: 'library', generationPrompt: null, durationSeconds: 5, sampleRate: 44100, channels: 2 }];
    seedStory(ctx);
    const { tools } = getStoryTools(ctx);
    updateTimeline = tools.find((t) => t.name === 'updateTimeline')!;

    await updateTimeline.execute('setup', {
      index: 0,
      deleteCount: -1,
      items: [
        { type: 'clip', videoId: 1, startTime: '00:00', endTime: '00:15' },
        { type: 'clip', videoId: 2, startTime: '00:00', endTime: '00:15' },
      ],
    });
  });

  it('reports auto-loop when music is shorter than clip span', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'music', startClip: 0, endClip: 1, musicId: 1, volume: 0.3 },
      ],
    });
    expect(result.content[0].text).toContain('auto-looped');
    expect(result.content[0].text).toContain('music (00:05 available)');
    expect(result.content[0].text).toContain('crossfade');
  });

  it('does not report loop when music is long enough', async () => {
    ctx.allMusic = [{ id: 1, filename: 'long.mp3', path: '/test/long.mp3', md5: 'y', type: 'library', generationPrompt: null, durationSeconds: 60, sampleRate: 44100, channels: 2 }];
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'music', startClip: 0, musicId: 1, volume: 0.5 },
      ],
    });
    expect(result.content[0].text).not.toContain('auto-looped');
  });
});

describe('watchSegment tool', () => {
  it('reports source video duration as MM:SS in range errors', async () => {
    const db = createTestDb();
    const ctx = createContext(db);
    ctx.allVideos = [{ id: 1, path: '/test/video1.mp4', filename: 'video1.mp4', durationSeconds: 371 }];
    const { tools } = getStoryTools(ctx);
    const watchSegment = tools.find((t) => t.name === 'watchSegment')!;

    await expect(watchSegment.execute('call-1', {
      videoId: 1,
      startTime: '08:30',
      endTime: '08:40',
    })).rejects.toThrow('duration 06:11');
  });
});
