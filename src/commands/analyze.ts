import chalk from 'chalk';
import * as readline from 'readline';
import { initDb } from '../db/index.js';
import { ensureProjectConfig, loadProjectConfig } from '../utils/project.js';
import { getModel } from '@mariozechner/pi-ai';
import { syncAndAnalyzeVideos, showVideoAnalysis, listVideos } from '../analyzer/video.js';
import { syncAndAnalyzeMusic, showMusicAnalysis, listMusic } from '../analyzer/music.js';
import { syncAndAnalyzeVoiceovers, showVoiceoverAnalysis, listVoiceovers } from '../analyzer/voiceover.js';
import { formatCost } from '../analyzer/utils.js';

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
