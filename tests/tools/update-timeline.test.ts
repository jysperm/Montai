import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema.js';
import { getStoryTools, type StoryToolsContext } from '../../src/agents/story-tools.js';

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
      models: { analysis: 'gemini-3.8-flash', editing: 'gemini-3.8-flash' },
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
    features: { music: true, musicGeneration: false, voiceover: false, voiceoverGeneration: false, previewTools: true, multiStory: true },
    skills: [],
    loadedSkills: new Set(),
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

function storedTimeline(ctx: StoryToolsContext): unknown {
  const row = (ctx.db as any).select().from(schema.stories).get();
  return JSON.parse(row.timeline);
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

describe('loadSkill tool', () => {
  it('is always registered', () => {
    const ctx = createContext(createTestDb());
    expect(getStoryTools(ctx).tools.some((tool) => tool.name === 'loadSkill')).toBe(true);
  });

  it('injects a user instruction once and remains idempotent', async () => {
    const ctx = createContext(createTestDb());
    ctx.skills = [{
      name: 'test-skill',
      description: 'Read for tests.',
      gatedBy: [],
      unlockTools: [],
      body: 'Follow this instruction.',
      path: '/skills/test-skill.md',
      source: 'builtin',
    }];
    const steered: unknown[] = [];
    ctx.agent = { state: { messages: [] }, steer: (message: unknown) => steered.push(message) } as any;
    const loadSkill = getStoryTools(ctx).tools.find((tool) => tool.name === 'loadSkill')!;

    await loadSkill.execute('call-1', { name: 'test-skill' });
    await loadSkill.execute('call-2', { name: 'test-skill' });

    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Follow this instruction.') });
    expect(ctx.loadedSkills).toEqual(new Set(['test-skill']));
  });

  it('requires the skill instructions to enter conversation history before unlocking a tool', async () => {
    const ctx = createContext(createTestDb());
    seedStory(ctx);
    ctx.skills = [{
      name: 'story-structure',
      description: 'Guide story structure.',
      gatedBy: [],
      unlockTools: ['updateStoryline'],
      body: 'Structure the story carefully.',
      path: '/skills/story-structure.md',
      source: 'project',
    }];
    const steered: any[] = [];
    ctx.agent = {
      state: { messages: [] },
      steer: (message: unknown) => steered.push(message),
    } as any;
    const { tools } = getStoryTools(ctx);
    const loadSkill = tools.find((tool) => tool.name === 'loadSkill')!;
    const updateStoryline = tools.find((tool) => tool.name === 'updateStoryline')!;

    expect(updateStoryline.description).toContain('Requires loading skill "story-structure" with loadSkill');
    await expect(updateStoryline.execute('call-1', { brief: 'Blocked' }))
      .rejects.toThrow('Call loadSkill for this skill first');

    await loadSkill.execute('call-2', { name: 'story-structure' });
    await expect(updateStoryline.execute('call-3', { brief: 'Still blocked' }))
      .rejects.toThrow('after the instructions have been added to the conversation');

    ctx.agent!.state.messages.push(steered[0]);
    await updateStoryline.execute('call-4', { brief: 'Unlocked' });
    const row = (ctx.db as any).select().from(schema.stories).get();
    expect(row.storyline).toBe('Unlocked');
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

  it('returns the timeline summary without corrections for valid items', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'overlay', text: 'Hello', startClip: 0, endClip: 1, position: 'bottom-center', style: 'subtitle' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatchInlineSnapshot(`
      "Timeline updated: 3 items (2 clips, 1 overlays)

      ## Computed Timeline (20.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s (10.0s) vid=1 source=00:00–00:10 [0]
        10.0–20.0s (10.0s) vid=1 source=00:10–00:20 [1]

      Overlays:
        0.0–20.0s "Hello" (20.0s)
      "
    `);
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
    expect(result.content[0].text).toMatchInlineSnapshot(`
      "Timeline updated: 4 items (2 clips, 1 overlays, 1 music)
      Corrections applied:
      - Music item (musicId=1): endClip clamped from 5 to 1 (total clips: 2)
      - Overlay "Late subtitle": startClip clamped from 9 to 1 (total clips: 2)
      - Overlay "Late subtitle": endClip clamped from 9 to 1 (total clips: 2)

      ## Computed Timeline (20.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s (10.0s) vid=1 source=00:00–00:10 [0]
        10.0–20.0s (10.0s) vid=1 source=00:10–00:20 [1]

      Overlays:
        10.0–20.0s "Late subti..." (10.0s)

      Music:
        0.0–20.0s (20.0s) music=1 source=00:00–00:20
      "
    `);
    expect(storedTimeline(ctx)).toMatchInlineSnapshot(`
      [
        {
          "endTime": "00:10",
          "startTime": "00:00",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endTime": "00:20",
          "startTime": "00:10",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endClip": 1,
          "musicId": 1,
          "startClip": 0,
          "type": "music",
          "volume": 0.5,
        },
        {
          "endClip": 1,
          "position": "bottom-center",
          "startClip": 1,
          "style": "subtitle",
          "text": "Late subtitle",
          "type": "overlay",
        },
      ]
    `);
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
    expect(storedTimeline(ctx)).toMatchInlineSnapshot(`
      [
        {
          "endTime": "00:10",
          "startTime": "00:00",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endTime": "00:20",
          "startTime": "00:10",
          "type": "clip",
          "videoId": 1,
        },
        {
          "position": "bottom-center",
          "startClip": 0,
          "style": "subtitle",
          "text": "Line 1
      Line 2",
          "type": "overlay",
        },
      ]
    `);
  });

  it('removes clips referencing missing videos', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'clip', videoId: 999, startTime: '00:00', endTime: '00:10' },
      ],
    });

    expect(result.content[0].text).toMatchInlineSnapshot(`
      "Timeline updated: 2 items (2 clips, 0 overlays)
      Corrections applied:
      - Clip (videoId=999): video not found in database — removed

      ## Computed Timeline (20.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s (10.0s) vid=1 source=00:00–00:10 [0]
        10.0–20.0s (10.0s) vid=1 source=00:10–00:20 [1]
      "
    `);
    expect(storedTimeline(ctx)).toMatchInlineSnapshot(`
      [
        {
          "endTime": "00:10",
          "startTime": "00:00",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endTime": "00:20",
          "startTime": "00:10",
          "type": "clip",
          "videoId": 1,
        },
      ]
    `);
  });

  it('removes audio referencing missing music', async () => {
    const result = await updateTimeline.execute('call-1', {
      index: 2,
      deleteCount: 0,
      items: [
        { type: 'music', startClip: 0, musicId: 999, volume: 0.5 },
      ],
    });

    expect(result.content[0].text).toMatchInlineSnapshot(`
      "Timeline updated: 2 items (2 clips, 0 overlays)
      Corrections applied:
      - Music item (musicId=999): music not found in database — removed

      ## Computed Timeline (20.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s (10.0s) vid=1 source=00:00–00:10 [0]
        10.0–20.0s (10.0s) vid=1 source=00:10–00:20 [1]
      "
    `);
    expect(storedTimeline(ctx)).toMatchInlineSnapshot(`
      [
        {
          "endTime": "00:10",
          "startTime": "00:00",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endTime": "00:20",
          "startTime": "00:10",
          "type": "clip",
          "videoId": 1,
        },
      ]
    `);
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
    expect(result.content[0].text).toMatchInlineSnapshot(`
      "Timeline updated: 3 items (2 clips, 0 overlays, 1 music)
      Corrections applied:
      - Music item (musicId=1): startTime 00:43 exceeds music duration 00:30 - set to 00:13
      - Music item (musicId=1): music (00:17 available) auto-looped 2× with 1s crossfade to cover ~20s span

      ## Computed Timeline (20.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–10.0s (10.0s) vid=1 source=00:00–00:10 [0]
        10.0–20.0s (10.0s) vid=1 source=00:10–00:20 [1]

      Music:
        0.0–20.0s (20.0s) music=1 source=00:13–00:33
      "
    `);
    expect(storedTimeline(ctx)).toMatchInlineSnapshot(`
      [
        {
          "endTime": "00:10",
          "startTime": "00:00",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endTime": "00:20",
          "startTime": "00:10",
          "type": "clip",
          "videoId": 1,
        },
        {
          "endClip": 1,
          "musicId": 1,
          "startClip": 0,
          "startTime": "00:13",
          "type": "music",
          "volume": 0.3,
        },
      ]
    `);
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
    expect(result.content[0].text).toMatchInlineSnapshot(`
      "Timeline updated: 3 items (2 clips, 0 overlays, 1 music)
      Corrections applied:
      - Music item (musicId=1): music (00:05 available) auto-looped 8× with 1s crossfade to cover ~30s span

      ## Computed Timeline (30.0s in total)

      Format: the leading time range and parenthesized duration are on the final timeline. \`source\` is the timestamp range in the source media file. The bracketed number is the clip index for startClip/endClip references.

      Clips:
        0.0–15.0s (15.0s) vid=1 source=00:00–00:15 [0]
        15.0–30.0s (15.0s) vid=2 source=00:00–00:15 [1]

      Music:
        0.0–30.0s (30.0s) music=1 source=00:00–00:30
      "
    `);
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
