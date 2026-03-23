import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { resolve, extname, basename, join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { ProjectConfigSchema, type ProjectConfig } from '../schemas/project.js';
import chalk from 'chalk';
import { eq, desc, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { stories, videos, videoAnalyses, music, musicAnalyses } from '../db/schema.js';
import { expandTimeline, type TimelineItem } from '../schemas/timeline-items.js';
import type { ExpandedTimeline } from '../schemas/timeline.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg']);

export function readProjectFile(filename: string): string | null {
  const filepath = resolve(filename);
  if (!existsSync(filepath)) return null;
  return readFileSync(filepath, 'utf-8');
}

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

export function loadProjectConfig(configPath = 'montai.yaml'): ProjectConfig {
  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Config file not found: ${resolvedPath}`);
    console.error('Run "montai analyze" to create a montai.yaml, or run this command from a Montai project directory.');
    process.exit(1);
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ProjectConfigSchema.parse(parsed);
}

export function resolveVideoFiles(config: ProjectConfig): string[] {
  const files: string[] = [];

  for (const entry of config.assets.videos) {
    const resolved = resolve(expandTilde(entry));

    try {
      const stat = statSync(resolved);

      if (stat.isDirectory()) {
        const dirFiles = readdirSync(resolved)
          .filter((f) => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
          .map((f) => join(resolved, f))
          .sort();
        files.push(...dirFiles);
      } else if (stat.isFile()) {
        if (VIDEO_EXTENSIONS.has(extname(resolved).toLowerCase())) {
          files.push(resolved);
        }
      }
    } catch {
      console.warn(`Warning: could not access path: ${resolved}`);
    }
  }

  return files;
}

export function getVideoFilename(filepath: string): string {
  return basename(filepath);
}

export function resolveMusicFiles(config: ProjectConfig): string[] {
  const files: string[] = [];

  for (const entry of config.assets.music) {
    const resolved = resolve(expandTilde(entry));

    try {
      const stat = statSync(resolved);

      if (stat.isDirectory()) {
        const dirFiles = readdirSync(resolved)
          .filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()))
          .map((f) => join(resolved, f))
          .sort();
        files.push(...dirFiles);
      } else if (stat.isFile()) {
        if (AUDIO_EXTENSIONS.has(extname(resolved).toLowerCase())) {
          files.push(resolved);
        }
      }
    } catch {
      console.warn(`Warning: could not access path: ${resolved}`);
    }
  }

  return files;
}

export function getMusicFilename(filepath: string): string {
  return basename(filepath);
}

type MusicAnalysisRow = InferSelectModel<typeof musicAnalyses>;

export function serializeMusicAnalysis(row: MusicAnalysisRow): string {
  return JSON.stringify({
    overview: row.overview,
    segments: JSON.parse(row.segments),
  });
}

type VideoAnalysisRow = InferSelectModel<typeof videoAnalyses>;

/**
 * Load timelines from the database, expanding raw TimelineItems into ExpandedTimeline format.
 * If name is given, loads that single story; otherwise loads all stories with timelines.
 * Returns null and prints an error if no timelines are found.
 */
export function loadExpandedTimelines(db: MontaiDb, config: ProjectConfig, name?: string): ExpandedTimeline[] | null {
  let storyRows: { name: string; title: string; timeline: string }[];
  if (name) {
    const row = db.select({ name: stories.name, title: stories.title, timeline: stories.timeline }).from(stories).where(eq(stories.name, name)).get();
    if (row?.timeline) {
      storyRows = [{ name: row.name, title: row.title, timeline: row.timeline }];
    } else {
      storyRows = [];
    }
  } else {
    storyRows = db.select({ name: stories.name, title: stories.title, timeline: stories.timeline })
      .from(stories)
      .where(sql`${stories.timeline} IS NOT NULL`)
      .orderBy(desc(stories.id))
      .all() as { name: string; title: string; timeline: string }[];
  }

  if (storyRows.length === 0) {
    console.log(
      chalk.red(
        name
          ? `Timeline "${name}" not found. Run "montai story" first.`
          : 'No timelines found. Run "montai story" first.',
      ),
    );
    return null;
  }

  const allVideos = db.select().from(videos).all();
  const allMusic = db.select().from(music).all();
  return storyRows.map(r => {
    const items = JSON.parse(r.timeline) as TimelineItem[];
    return expandTimeline(items, config, r.name, allVideos, r.title, allMusic);
  });
}

export function serializeVideoAnalysis(row: VideoAnalysisRow): string {
  return JSON.stringify({
    overview: row.overview,
    location: row.location,
    timeOfDay: row.timeOfDay,
    segments: JSON.parse(row.segments),
    highlights: JSON.parse(row.highlights),
    technicalNotes: row.technicalNotes,
  });
}
