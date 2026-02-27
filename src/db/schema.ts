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
  bitDepth: integer('bit_depth'),
  colorSpace: text('color_space'),
  colorPrimaries: text('color_primaries'),
  colorTransfer: text('color_transfer'),
  totalFrames: integer('total_frames'),
  audioChannels: integer('audio_channels'),
  audioSampleRate: integer('audio_sample_rate'),
  startTimecode: text('start_timecode'),   // e.g. "15:03:38;24"
});

export const videoSummaries = sqliteTable('video_summaries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoId: integer('video_id')
    .notNull()
    .references(() => videos.id),
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
  generatedOverview: text('generated_overview'),
  generatedOverviewStale: integer('generated_overview_stale', { mode: 'boolean' }),
  updatedAt: text('updated_at').notNull(),
});

export const storylines = sqliteTable('storylines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codename: text('codename').notNull().unique(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

export const timelines = sqliteTable('timelines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  storylineId: integer('storyline_id')
    .notNull()
    .references(() => storylines.id),
  spec: text('spec').notNull(),
  createdAt: text('created_at').notNull(),
});

export const geminiFiles = sqliteTable('gemini_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoId: integer('video_id')
    .notNull()
    .references(() => videos.id),
  fileUri: text('file_uri').notNull(),
  uploadedAt: text('uploaded_at').notNull(),
  state: text('state').notNull(),
});
