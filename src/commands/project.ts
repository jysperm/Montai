import chalk from 'chalk';
import ora from 'ora';
import { statSync } from 'fs';
import { asc, eq, desc } from 'drizzle-orm';
import { initDb } from '../db/index.js';
import { videos, videoAnalyses, music, stories, projectContext } from '../db/schema.js';
import { loadProjectConfig } from '../utils/project.js';
import { renderPrompt } from '../prompts/index.js';
import { getModel } from '@mariozechner/pi-ai';
import { assertComplete, getTextContent } from '../analyzer/utils.js';
import { completeWithLogging } from '../utils/llm-logging.js';

function formatDuration(seconds: number): string {
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return s > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatVideoSpec(v: { width: number | null; height: number | null; fps: string | null; bitDepth: number | null; colorTransfer: string | null }): string {
  const parts: string[] = [];

  // Resolution label
  if (v.width && v.height) {
    const h = Math.min(v.width, v.height); // handle portrait
    if (h >= 2160) parts.push('4K');
    else if (h >= 1440) parts.push('1440p');
    else if (h >= 1080) parts.push('1080p');
    else if (h >= 720) parts.push('720p');
    else parts.push(`${v.width}x${v.height}`);
  }

  // FPS
  if (v.fps) {
    const fpsVal = parseFloat(v.fps);
    parts.push(Number.isInteger(fpsVal) ? `${fpsVal}p` : `${fpsVal}p`);
  }

  // 10bit (only if not 8)
  if (v.bitDepth && v.bitDepth > 8) {
    parts.push(`${v.bitDepth}bit`);
  }

  // HDR (only if present)
  if (v.colorTransfer && (v.colorTransfer === 'hlg' || v.colorTransfer === 'pq')) {
    parts.push('HDR');
  }

  return parts.join(' ');
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days !== 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  return 'just now';
}

function formatItemCounts(items: Array<{ type: string }>): string {
  const clips = items.filter(i => i.type === 'clip').length;
  const overlays = items.filter(i => i.type === 'overlay').length;
  const audio = items.filter(i => i.type === 'audio').length;
  const parts: string[] = [];
  if (clips > 0) parts.push(`${clips} clip${clips !== 1 ? 's' : ''}`);
  if (overlays > 0) parts.push(`${overlays} overlay${overlays !== 1 ? 's' : ''}`);
  if (audio > 0) parts.push(`${audio} audio`);
  return parts.join(', ') || 'nothing';
}

function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function projectCommand(options: { addFact?: string; facts?: boolean }) {
  const config = loadProjectConfig();
  const db = await initDb();

  if (options.addFact) {
    const existing = db.select().from(projectContext).get();
    const prompt = renderPrompt('merge-facts', { existingFacts: existing?.facts ?? null, newFact: options.addFact, language: config.language });

    const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const spinner = ora('Merging fact...').start();

    const result = await completeWithLogging(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
    }, { apiKey });
    assertComplete(result);
    const mergedFacts = getTextContent(result).trim();

    if (existing) {
      db.update(projectContext)
        .set({ facts: mergedFacts, overviewStale: true, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ facts: mergedFacts, updatedAt: new Date().toISOString() })
        .run();
    }

    spinner.succeed('Fact added');
    console.log(chalk.dim(mergedFacts));
    return;
  }

  if (options.facts) {
    const existing = db.select().from(projectContext).get();
    if (existing?.facts) {
      console.log(chalk.bold('Project Facts'));
      console.log(existing.facts);
    } else {
      console.log(chalk.yellow('No project facts yet. Use `montai project --add-fact "<text>"` to add one.'));
    }
    return;
  }

  // Default: show project overview + stats

  // --- Overview ---
  const existing = db.select().from(projectContext).get();
  let overview: string | null = null;

  if (existing?.overview && !existing.overviewStale) {
    console.log(chalk.bold('Overview') + chalk.dim(' (cached)'));
    console.log(existing.overview);
  } else {
    const allAnalyses = db
      .select({
        videoId: videoAnalyses.videoId,
        filename: videos.filename,
        overview: videoAnalyses.overview,
        location: videoAnalyses.location,
        timeOfDay: videoAnalyses.timeOfDay,
      })
      .from(videoAnalyses)
      .innerJoin(videos, eq(videoAnalyses.videoId, videos.id))
      .orderBy(asc(videos.filename))
      .all();

    if (allAnalyses.length === 0) {
      console.log(chalk.dim('No video analyses yet — run `montai analyze` to generate overview.'));
    } else {
      const prompt = renderPrompt('project-overview', { facts: existing?.facts ?? null, videoAnalyses: allAnalyses, language: config.language });
      const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const spinner = ora('Generating overview...').start();

      const result = await completeWithLogging(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
      }, { apiKey });
      assertComplete(result);
      overview = getTextContent(result).trim();

      spinner.succeed('Overview generated');
      console.log(chalk.bold('Overview'));
      console.log(overview);
    }
  }

  // --- Stories ---
  const allStories = db.select().from(stories).orderBy(desc(stories.id)).all();
  if (allStories.length > 0) {
    console.log();
    console.log(chalk.bold('Stories'));
    for (const s of allStories) {
      let status: string;
      if (s.timeline) {
        const items = JSON.parse(s.timeline) as Array<{ type: string }>;
        status = chalk.green(formatItemCounts(items));
      } else {
        status = chalk.dim('empty');
      }
      const ago = formatTimeAgo(s.updatedAt);
      console.log(`  ${chalk.cyan(s.name)}  ${s.title}  [${status}]  ${chalk.dim(ago)}`);
    }
  }

  // --- Videos ---
  const allVideos = db.select().from(videos).all();
  if (allVideos.length > 0) {
    const totalDuration = allVideos.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0);
    const totalSize = allVideos.reduce((sum, v) => sum + getFileSize(v.path), 0);

    const specCounts = new Map<string, number>();
    for (const v of allVideos) {
      const spec = formatVideoSpec(v);
      if (spec) specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
    }

    const maxCountWidth = Math.max(...Array.from(specCounts.values()).map(c => String(c).length));
    console.log();
    console.log(chalk.bold('Videos'));
    console.log(chalk.dim(`  ${allVideos.length} files, ${formatDuration(totalDuration)}, ${formatBytes(totalSize)}`));
    for (const [spec, count] of specCounts.entries()) {
      const label = count > 1 ? `${String(count).padStart(maxCountWidth)}× ${spec}` : `${' '.repeat(maxCountWidth + 2)}${spec}`;
      console.log(`  ${label}`);
    }
  }

  // --- Music ---
  const allMusic = db.select().from(music).all();
  if (allMusic.length > 0) {
    const totalDuration = allMusic.reduce((sum, m) => sum + (m.durationSeconds ?? 0), 0);
    const totalSize = allMusic.reduce((sum, m) => sum + getFileSize(m.path), 0);
    console.log();
    console.log(chalk.bold('Music Library'));
    console.log(chalk.dim(`  ${allMusic.length} files, ${formatDuration(totalDuration)}, ${formatBytes(totalSize)}`));
  }

  // --- Settings ---
  console.log();
  console.log(chalk.bold('Settings'));
  console.log(chalk.dim('  Output: ') + `${config.output.resolution} ${config.output.fps}fps`);
  console.log(chalk.dim('  Models: ') + chalk.dim('analysis=') + config.models.analysis + chalk.dim(', editing=') + config.models.editing);
  console.log(chalk.dim('  Language: ') + config.language + chalk.dim(', effects: ') + config.effects.languages.join(', '));

  // Save generated overview to DB
  if (overview) {
    if (existing) {
      db.update(projectContext)
        .set({ overview, overviewStale: false, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ facts: '', overview, overviewStale: false, updatedAt: new Date().toISOString() })
        .run();
    }
  }
}
