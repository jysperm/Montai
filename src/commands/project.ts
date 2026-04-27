import chalk from 'chalk';
import ora from 'ora';
import { statSync } from 'fs';
import { createHash } from 'crypto';
import { asc, eq, desc } from 'drizzle-orm';
import { initDb } from '../db/index.js';
import { videos, videoAnalyses, music, voiceovers, stories, projectContext } from '../db/schema.js';
import { loadProjectConfig, readProjectFile } from '../utils/project.js';
import { renderPrompt } from '../prompts/index.js';
import { getModel } from '@mariozechner/pi-ai';
import { assertComplete, getTextContent } from '../analyzer/utils.js';
import { completeWithLogging } from '../utils/llm-logging.js';
import { formatDuration, formatTimeAgo, formatFileSize, formatStoryLine } from '../utils/format.js';
import { parseTimeToSeconds } from '../analyzer/video.js';

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

function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function projectCommand(_options: Record<string, never> = {}) {
  const config = loadProjectConfig();
  const db = await initDb();

  // Default: show project overview + stats

  // --- Overview ---
  const existing = db.select().from(projectContext).get();
  const agentInstructions = readProjectFile('AGENTS.md');
  const agentsHash = createHash('md5').update(agentInstructions ?? '').digest('hex');
  let overview: string | null = null;

  const cacheValid = existing?.overview && !existing.overviewStale && existing.agentsHash === agentsHash;
  if (cacheValid) {
    console.log(chalk.bold('Overview') + chalk.dim(' (cached)'));
    console.log(existing!.overview!);
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
      console.log(chalk.dim(`No video analyses yet — run ${chalk.reset.bold('montai analyze')} to generate overview.`));
    } else {
      const prompt = renderPrompt('project-overview', { agentInstructions: agentInstructions ?? null, videoAnalyses: allAnalyses, language: config.language });
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
      console.log(formatStoryLine(s, { indent: true }));
    }
  }

  // --- Videos ---
  const allVideos = db.select().from(videos).all();
  if (allVideos.length > 0) {
    const totalDuration = allVideos.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0);
    const totalSize = allVideos.reduce((sum, v) => sum + getFileSize(v.path), 0);

    let highlightPct: number | null = null;
    if (totalDuration > 0) {
      const allAnalyses = db.select().from(videoAnalyses).all();
      let totalHighlightSeconds = 0;
      for (const a of allAnalyses) {
        const highlights = JSON.parse(a.highlights) as Array<{ startTime: string; endTime: string }>;
        for (const hl of highlights) {
          totalHighlightSeconds += parseTimeToSeconds(hl.endTime) - parseTimeToSeconds(hl.startTime);
        }
      }
      if (totalHighlightSeconds > 0) {
        highlightPct = Math.round((totalHighlightSeconds / totalDuration) * 100);
      }
    }

    const specCounts = new Map<string, number>();
    for (const v of allVideos) {
      const spec = formatVideoSpec(v);
      if (spec) specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
    }

    const maxCountWidth = Math.max(...Array.from(specCounts.values()).map(c => String(c).length));
    const highlightSuffix = highlightPct != null ? `, ${highlightPct}% highlights` : '';
    console.log();
    console.log(chalk.bold('Videos'));
    console.log(chalk.dim(`  ${allVideos.length} files, ${formatDuration(totalDuration)}, ${formatFileSize(totalSize)}${highlightSuffix}`));
    for (const [spec, count] of specCounts.entries()) {
      const label = count > 1 ? `${String(count).padStart(maxCountWidth)}× ${spec}` : `${' '.repeat(maxCountWidth + 2)}${spec}`;
      console.log(`  ${label}`);
    }
  }

  // --- Music ---
  const allMusic = db.select().from(music).all();
  const libraryMusic = allMusic.filter(m => m.type !== 'generated');
  const generatedMusic = allMusic.filter(m => m.type === 'generated');
  if (libraryMusic.length > 0 || generatedMusic.length > 0) {
    console.log();
    console.log(chalk.bold('Music'));
    if (libraryMusic.length > 0) {
      const totalDuration = libraryMusic.reduce((sum, m) => sum + (m.durationSeconds ?? 0), 0);
      const totalSize = libraryMusic.reduce((sum, m) => sum + getFileSize(m.path), 0);
      console.log(chalk.dim(`  Library: ${libraryMusic.length} files, ${formatDuration(totalDuration)}, ${formatFileSize(totalSize)}`));
    }
    if (generatedMusic.length > 0) {
      const totalDuration = generatedMusic.reduce((sum, m) => sum + (m.durationSeconds ?? 0), 0);
      const totalSize = generatedMusic.reduce((sum, m) => sum + getFileSize(m.path), 0);
      console.log(chalk.dim(`  Generated: ${generatedMusic.length} tracks, ${formatDuration(totalDuration)}, ${formatFileSize(totalSize)}`));
    }
  }

  // --- Voiceovers ---
  const allVoiceovers = db.select().from(voiceovers).all();
  if (allVoiceovers.length > 0) {
    const totalDuration = allVoiceovers.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0);
    const totalSize = allVoiceovers.reduce((sum, v) => sum + getFileSize(v.path), 0);
    console.log();
    console.log(chalk.bold('Voiceovers'));
    console.log(chalk.dim(`  ${allVoiceovers.length} files, ${formatDuration(totalDuration)}, ${formatFileSize(totalSize)}`));
  }

  // --- Settings ---
  console.log();
  console.log(chalk.bold('Settings'));
  console.log(chalk.dim('  Output: ') + `${config.output.resolution} ${config.output.fps}fps`);
  console.log(chalk.dim('  Models: ') + chalk.dim('analysis=') + config.models.analysis + chalk.dim(', editing=') + config.models.editing + (config.models.musicGeneration ? chalk.dim(', musicGeneration=') + config.models.musicGeneration : ''));
  console.log(chalk.dim('  Language: ') + config.language + chalk.dim(', effects: ') + config.effects.languages.join(', '));

  // Save generated overview to DB
  if (overview) {
    if (existing) {
      db.update(projectContext)
        .set({ overview, overviewStale: false, agentsHash, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ overview, overviewStale: false, agentsHash, updatedAt: new Date().toISOString() })
        .run();
    }
  }
}
