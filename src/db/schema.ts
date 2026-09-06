import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Changing this file needs a migration: run `npm run db:generate`, which writes one to `drizzle/`.

export const videos = sqliteTable('videos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  path: text('path').notNull().unique(),
  md5: text('md5').notNull(),
  durationSeconds: integer('duration_seconds'),
  width: integer('width'),
  height: integer('height'),
  fpsNum: integer('fps_num'),       // frame rate numerator, e.g. 60000
  fpsDen: integer('fps_den'),       // frame rate denominator, e.g. 1001
  fps: text('fps'),               // decimal string, e.g. "59.94", "50"
  bitDepth: integer('bit_depth'),
  colorPrimaries: text('color_primaries'),
  colorTransfer: text('color_transfer'),
  totalFrames: integer('total_frames'),
  audioChannels: integer('audio_channels'),
  audioSampleRate: integer('audio_sample_rate'),
  startTimecode: text('start_timecode'),   // e.g. "15:03:38;24"
});

export const videoAnalyses = sqliteTable('video_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoId: integer('video_id').notNull().references(() => videos.id),
  overview: text('overview').notNull(),
  location: text('location'),
  timeOfDay: text('time_of_day'),
  segments: text('segments').notNull(), // JSON array
  highlights: text('highlights').notNull(), // JSON array
  technicalNotes: text('technical_notes'),
  analyzedAt: text('analyzed_at'),
  montaiVersion: text('montai_version'),
  model: text('model'),
  promptHash: text('prompt_hash'),
});

export const projectContext = sqliteTable('project_context', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  overview: text('overview'),
  overviewStale: integer('overview_stale', { mode: 'boolean' }),
  agentsHash: text('agents_hash'),
  updatedAt: text('updated_at').notNull(),
});

export const stories = sqliteTable('stories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  title: text('title').notNull(),
  storyline: text('storyline'),
  timeline: text('timeline'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const storyMarks = sqliteTable('story_marks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  timeline: text('timeline').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  uniqueIndex('story_marks_story_id_name_unique').on(t.storyId, t.name),
]);

export const music = sqliteTable('music', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  path: text('path').notNull().unique(),
  md5: text('md5').notNull(),
  type: text('type').default('library'),              // 'library' | 'generated'
  generationPrompt: text('generation_prompt'),         // null for library, the prompt text for generated
  durationSeconds: integer('duration_seconds'),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
});

export const musicAnalyses = sqliteTable('music_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  musicId: integer('music_id').notNull().references(() => music.id),
  overview: text('overview').notNull(),
  segments: text('segments').notNull(), // JSON array
  analyzedAt: text('analyzed_at'),
  montaiVersion: text('montai_version'),
  model: text('model'),
  promptHash: text('prompt_hash'),
});

export const voiceovers = sqliteTable('voiceovers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  path: text('path').notNull().unique(),
  md5: text('md5').notNull(),
  type: text('type').default('recording'),            // 'recording' | 'generated'
  generationText: text('generation_text'),             // null for recordings, the script text for generated (TTS)
  durationSeconds: integer('duration_seconds'),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
});

export const voiceoverAnalyses = sqliteTable('voiceover_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceoverId: integer('voiceover_id').notNull().references(() => voiceovers.id),
  transcription: text('transcription').notNull(), // JSON array
  overview: text('overview').notNull(),
  analyzedAt: text('analyzed_at'),
  montaiVersion: text('montai_version'),
  model: text('model'),
  promptHash: text('prompt_hash'),
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  currentStoryId: integer('current_story_id').references(() => stories.id, { onDelete: 'cascade' }),
});

export const sessionMessages = sqliteTable('session_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
});

export const geminiFiles = sqliteTable('gemini_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Nullable so old upload-cache rows can migrate without blocking schema push.
  // Rows without cacheKey are ignored by the current path-keyed cache.
  cacheKey: text('cache_key').unique(),
  fileUri: text('file_uri').notNull(),
  uploadedAt: text('uploaded_at').notNull(),
  state: text('state').notNull(),
});
