import chalk from 'chalk';
import * as readline from 'readline';
import { initDb } from '../db/index.js';
import { loadProjectConfig } from '../utils/project.js';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getModel } from '@mariozechner/pi-ai';
import { syncAndAnalyzeVideos, showVideoAnalysis, listVideos } from '../analyzer/video.js';
import { syncAndAnalyzeMusic, showMusicAnalysis, listMusic } from '../analyzer/music.js';
import { syncAndAnalyzeVoiceovers, showVoiceoverAnalysis, listVoiceovers } from '../analyzer/voiceover.js';
import { formatCost } from '../analyzer/utils.js';

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

export async function analyzeCommand(options: { reRun?: string; show?: string; list?: boolean }) {
  await ensureProjectConfig();
  const config = loadProjectConfig();
  const db = await initDb();

  if (options.list) {
    listVideos(db);
    listMusic(db);
    listVoiceovers(db);
    return;
  }

  if (options.show) {
    showVideoAnalysis(db, options.show);
    showMusicAnalysis(db, options.show);
    showVoiceoverAnalysis(db, options.show);
    return;
  }

  const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
  let totalCost = 0;

  const videoResult = await syncAndAnalyzeVideos(db, config, model, { reRun: options.reRun });
  totalCost += videoResult.totalCost;

  const musicResult = await syncAndAnalyzeMusic(db, config, model, { reRun: options.reRun });
  totalCost += musicResult.totalCost;

  const voiceoverResult = await syncAndAnalyzeVoiceovers(db, config, model, { reRun: options.reRun });
  totalCost += voiceoverResult.totalCost;

  console.log(chalk.dim(`Total cost: ${formatCost(totalCost)}`));
}
