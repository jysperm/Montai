import { readFileSync, statSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, extname, basename, join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import * as readline from 'readline';
import { ProjectConfigSchema, type ProjectConfig } from '../schemas/project.js';
import chalk from 'chalk';
import { eq, desc, sql } from 'drizzle-orm';
import type { MontaiDb } from '../db/index.js';
import { stories, videos, music, voiceovers } from '../db/schema.js';
import { TimelineItemSchema, type TimelineItem } from '../schemas/timeline.js';
import { resolveTimeline } from '../schemas/timeline/resolve.js';
import { z } from 'zod';
import type { ResolvedTimeline } from '../schemas/timeline.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg']);

export const DEFAULT_PROJECT_CONFIG_YAML = `assets:
  videos:
    - .
language: en
output:
  resolution: 1080p
  fps: 50
models:
  analysis: gemini-3.5-flash
  editing: gemini-3.5-flash
effects:
  languages: [zh, en]
`;

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
    console.log(chalk.red(`Config file not found: ${resolvedPath}`));
    console.log(`Run ${chalk.bold('montai analyze')} to create a montai.yaml, or run from a Montai project directory.`);
    process.exit(1);
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ProjectConfigSchema.parse(parsed);
}

export async function ensureProjectConfig(configPath = 'montai.yaml'): Promise<void> {
  const resolvedPath = resolve(configPath);
  if (existsSync(resolvedPath)) return;

  console.log(chalk.yellow(`Config file not found: ${resolvedPath}`));
  console.log(chalk.dim(`Will create with default content:\n${DEFAULT_PROJECT_CONFIG_YAML}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((res) => {
    rl.question(chalk.blue('Press Enter to create, or Ctrl-C to cancel... '), () => {
      rl.close();
      res();
    });
  });

  writeFileSync(resolvedPath, DEFAULT_PROJECT_CONFIG_YAML, 'utf-8');
  console.log(chalk.green(`Created ${resolvedPath}`));
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
      console.log(chalk.yellow(`Warning: could not access path: ${resolved}`));
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
      console.log(chalk.yellow(`Warning: could not access path: ${resolved}`));
    }
  }

  return files;
}

export function getMusicFilename(filepath: string): string {
  return basename(filepath);
}

export function resolveVoiceoverFiles(config: ProjectConfig): string[] {
  const files: string[] = [];

  for (const entry of config.assets.voiceover) {
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
      console.log(chalk.yellow(`Warning: could not access path: ${resolved}`));
    }
  }

  return files;
}

export function getVoiceoverFilename(filepath: string): string {
  return basename(filepath);
}

/**
 * Load timelines from the database, expanding raw TimelineItems into ResolvedTimeline format.
 * If name is given, loads that single story; otherwise loads all stories with timelines.
 * Returns null and prints an error if no timelines are found.
 */
export interface LoadResolvedOptions {
  quiet?: boolean;
}

export interface LoadResolvedResult {
  timelines: ResolvedTimeline[];
  correctionCount: number;
  errors: string[];
}

export function loadResolvedTimelines(db: MontaiDb, config: ProjectConfig, name?: string, options?: LoadResolvedOptions): LoadResolvedResult {
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
    if (!options?.quiet) {
      console.log(
        chalk.yellow(
          name
            ? `Timeline "${name}" not found. Run ${chalk.bold('montai story')} first.`
            : `No timelines found. Run ${chalk.bold('montai story')} first.`,
        ),
      );
    }
    return { timelines: [], correctionCount: 0, errors: [] };
  }

  const allVideos = db.select().from(videos).all();
  const allMusic = db.select().from(music).all();
  const allVoiceovers = db.select().from(voiceovers).all();
  let correctionCount = 0;
  const allErrors: string[] = [];
  const timelines = storyRows.map(r => {
    const items = z.array(TimelineItemSchema).parse(JSON.parse(r.timeline));
    const { timeline, corrections, errors } = resolveTimeline(items, config, r.name, allVideos, r.title, allMusic, allVoiceovers);
    correctionCount += corrections.length;
    allErrors.push(...errors);
    if (!options?.quiet) {
      if (corrections.length > 0) {
        console.log(chalk.yellow(`Timeline "${r.name}" corrections:\n${corrections.map((c) => `  - ${c}`).join('\n')}`));
      }
      if (errors.length > 0) {
        console.log(chalk.red(`Timeline "${r.name}" errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`));
      }
    }
    return timeline;
  });
  return { timelines, correctionCount, errors: allErrors };
}
