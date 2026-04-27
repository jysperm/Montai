import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
});

export const projectContext = sqliteTable('project_context', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  facts: text('facts').notNull(),
  overview: text('overview'),
  overviewStale: integer('overview_stale', { mode: 'boolean' }),
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
});

export const voiceovers = sqliteTable('voiceovers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  path: text('path').notNull().unique(),
  md5: text('md5').notNull(),
  durationSeconds: integer('duration_seconds'),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
});

export const voiceoverAnalyses = sqliteTable('voiceover_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceoverId: integer('voiceover_id').notNull().references(() => voiceovers.id),
  transcription: text('transcription').notNull(), // JSON array
  overview: text('overview').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  currentStoryId: integer('current_story_id').references(() => stories.id),
});

export const sessionMessages = sqliteTable('session_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull().references(() => sessions.id),
  content: text('content').notNull(),
});

export const geminiFiles = sqliteTable('gemini_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoId: integer('video_id').references(() => videos.id),
  musicId: integer('music_id').references(() => music.id),
  voiceoverId: integer('voiceover_id').references(() => voiceovers.id),
  fileUri: text('file_uri').notNull(),
  uploadedAt: text('uploaded_at').notNull(),
  state: text('state').notNull(),
});
