import chalk from 'chalk';
import * as readline from 'readline';
import { initDb, type MontaiDb } from '../db/index.js';
import { ensureProjectConfig, loadProjectConfig } from '../utils/project.js';
import { getGeminiModel } from '../gemini/models.js';
import { syncVideos, showVideoAnalysis, listVideos } from '../analyzer/video.js';
import { syncMusic, showMusicAnalysis, listMusic } from '../analyzer/music.js';
import { syncVoiceovers, showVoiceoverAnalysis, listVoiceovers } from '../analyzer/voiceover.js';
import { runAnalysisPipeline } from '../analyzer/pipeline.js';
import { formatCost } from '../analyzer/utils.js';

export function showMediaAnalysis(db: MontaiDb, filename: string): boolean {
  const foundVideo = showVideoAnalysis(db, filename);
  const foundMusic = showMusicAnalysis(db, filename);
  const foundVoiceover = showVoiceoverAnalysis(db, filename);
  return foundVideo || foundMusic || foundVoiceover;
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
    if (showMediaAnalysis(db, options.show)) {
      return;
    }
    console.log(chalk.red(`Media "${options.show}" not found.`));
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

  const model = getGeminiModel(config.models.analysis);

  // Discover and register all media types, then run them through one shared pipeline.
  const items = [
    ...await syncVideos(db, config, { reRun: reRunFile, reRunAll }),
    ...await syncMusic(db, config, { reRun: reRunFile, reRunAll }),
    ...await syncVoiceovers(db, config, { reRun: reRunFile, reRunAll }),
  ];

  const { totalCost } = await runAnalysisPipeline(db, config, model, items);

  console.log(chalk.dim(`Total cost: ${formatCost(totalCost)}`));
}
