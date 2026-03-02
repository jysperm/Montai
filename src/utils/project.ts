import { readFileSync, statSync, readdirSync } from 'fs';
import { resolve, extname, basename, join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { ProjectConfigSchema, type ProjectConfig } from '../schemas/project.js';
import type { videoSummaries } from '../db/schema.js';
import type { InferSelectModel } from 'drizzle-orm';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv']);

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

export function loadProjectConfig(configPath = 'montai.yaml'): ProjectConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ProjectConfigSchema.parse(parsed);
}

export function resolveVideoFiles(config: ProjectConfig): string[] {
  const files: string[] = [];

  for (const entry of config.videos) {
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

type VideoSummaryRow = InferSelectModel<typeof videoSummaries>;

export function serializeVideoSummary(row: VideoSummaryRow): string {
  return JSON.stringify({
    overview: row.overview,
    location: row.location,
    timeOfDay: row.timeOfDay,
    segments: JSON.parse(row.segments),
    highlights: JSON.parse(row.highlights),
    technicalNotes: row.technicalNotes,
  });
}
