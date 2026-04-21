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
language: en
output:
  resolution: 1080p
  fps: 50
models:
  analysis: gemini-3-flash-preview
  editing: gemini-3.1-pro-preview
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

export async function analyzeCommand(options: { reRun?: string | boolean; force?: boolean; show?: string; list?: boolean }) {
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

  let reRunAll = false;
  let reRunFile: string | undefined;

  if (options.reRun === true) {
    if (!options.force) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) => {
        rl.question(chalk.yellow('Re-analyze ALL videos, music, and voiceover files? (y/N) '), (a) => {
          rl.close();
          res(a);
        });
      });
      const normalized = answer.trim().toLowerCase();
      if (normalized !== 'y' && normalized !== 'yes') {
        console.log(chalk.dim('Cancelled.'));
        return;
      }
    }
    reRunAll = true;
  } else if (typeof options.reRun === 'string') {
    reRunFile = options.reRun;
  }

  const model = getModel('google', config.models.analysis as Parameters<typeof getModel>[1]);
  let totalCost = 0;

  const videoResult = await syncAndAnalyzeVideos(db, config, model, { reRun: reRunFile, reRunAll });
  totalCost += videoResult.totalCost;

  const musicResult = await syncAndAnalyzeMusic(db, config, model, { reRun: reRunFile, reRunAll });
  totalCost += musicResult.totalCost;

  const voiceoverResult = await syncAndAnalyzeVoiceovers(db, config, model, { reRun: reRunFile, reRunAll });
  totalCost += voiceoverResult.totalCost;

  console.log(chalk.dim(`Total cost: ${formatCost(totalCost)}`));
}
