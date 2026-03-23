import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { asc, eq } from 'drizzle-orm';
import { initDb } from '../db/index.js';
import { videos, videoAnalyses, projectContext } from '../db/schema.js';
import { loadProjectConfig, readProjectFile } from '../utils/project.js';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { videoAnalysisPrompt, mergeFactsPrompt, projectOverviewPrompt } from '../prompts/index.js';
import { getModel } from '@mariozechner/pi-ai';
import { syncAndAnalyzeVideos, showVideoAnalysis, listVideos } from '../analyzer/video.js';
import { syncAndAnalyzeMusic, showMusicAnalysis, listMusic } from '../analyzer/music.js';
import { assertComplete, getTextContent, formatCost } from '../analyzer/utils.js';
import { completeWithLogging } from '../utils/llm-logging.js';

async function ensureProjectConfig(configPath = 'montai.yaml'): Promise<void> {
  const resolvedPath = resolve(configPath);
  if (existsSync(resolvedPath)) return;

  const defaultConfig = `assets:
  videos:
    - .
  music: []
language: en
output:
  resolution: 1080p
  fps: 50
models:
  analysis: gemini-3-flash-preview
  editing: gemini-3-pro-preview
effects:
  languages: [zh, en]
`;
  console.log(chalk.yellow(`Config file not found: ${resolvedPath}`));
  console.log(chalk.dim(`Will create with default content:\n${defaultConfig}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((res) => {
    rl.question(chalk.blue('Press Enter to create, or Ctrl-C to cancel... '), () => {
      rl.close();
      res();
    });
  });

  writeFileSync(resolvedPath, defaultConfig, 'utf-8');
  console.log(chalk.green(`Created ${resolvedPath}`));
}

export async function analyzeCommand(options: { reRun?: string; show?: string; list?: boolean; addFact?: string; project?: boolean }) {
  await ensureProjectConfig();
  const config = loadProjectConfig();
  const db = await initDb();

  if (options.addFact) {
    const existing = db.select().from(projectContext).get();
    const prompt = mergeFactsPrompt(existing?.facts ?? null, options.addFact, config.language);

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
        .set({ facts: mergedFacts, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ facts: mergedFacts, updatedAt: new Date().toISOString() })
        .run();
    }

    if (existing) {
      db.update(projectContext)
        .set({ generatedOverviewStale: true })
        .where(eq(projectContext.id, existing.id))
        .run();
    }

    spinner.succeed('Fact added');
    console.log(chalk.dim(mergedFacts));
    return;
  }

  if (options.project) {
    const existing = db.select().from(projectContext).get();

    if (existing?.generatedOverview && !existing.generatedOverviewStale) {
      console.log(chalk.bold('Project Overview') + chalk.dim(' (cached)'));
      console.log(existing.generatedOverview);
      return;
    }

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
      console.log(chalk.yellow('No video analyses yet. Run `montai analyze` first.'));
      return;
    }

    const prompt = projectOverviewPrompt(existing?.facts ?? null, allAnalyses, config.language);
    const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const spinner = ora('Generating project overview...').start();

    const result = await completeWithLogging(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
    }, { apiKey });
    assertComplete(result);
    const overview = getTextContent(result).trim();

    if (existing) {
      db.update(projectContext)
        .set({ generatedOverview: overview, generatedOverviewStale: false, updatedAt: new Date().toISOString() })
        .where(eq(projectContext.id, existing.id))
        .run();
    } else {
      db.insert(projectContext)
        .values({ facts: '', generatedOverview: overview, generatedOverviewStale: false, updatedAt: new Date().toISOString() })
        .run();
    }

    spinner.succeed('Project overview generated');
    console.log(chalk.bold('Project Overview'));
    console.log(overview);
    return;
  }

  if (options.list) {
    listVideos(db);
    listMusic(db);
    return;
  }

  if (options.show) {
    showVideoAnalysis(db, options.show);
    showMusicAnalysis(db, options.show);
    return;
  }

  const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
  let totalCost = 0;

  const videoResult = await syncAndAnalyzeVideos(db, config, model, { reRun: options.reRun });
  totalCost += videoResult.totalCost;

  const musicResult = await syncAndAnalyzeMusic(db, config, model, { reRun: options.reRun });
  totalCost += musicResult.totalCost;

  console.log(chalk.dim(`Total cost: ${formatCost(totalCost)}`));
}
