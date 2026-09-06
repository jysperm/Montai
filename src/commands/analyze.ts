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
import { analysisSignature, type SyncOptions } from '../analyzer/provenance.js';
import type { AnalyzeKind } from '../analyzer/pipeline.js';

export function showMediaAnalysis(db: MontaiDb, filename: string): boolean {
  const foundVideo = showVideoAnalysis(db, filename);
  const foundMusic = showMusicAnalysis(db, filename);
  const foundVoiceover = showVoiceoverAnalysis(db, filename);
  return foundVideo || foundMusic || foundVoiceover;
}

async function confirmRefreshAll(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    rl.question(chalk.yellow('Re-analyze ALL videos, music, and voiceover files? (y/N) '), (a) => {
      rl.close();
      res(a);
    });
  });
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

export async function analyzeCommand(options: { refresh?: string | boolean; all?: boolean; force?: boolean; show?: string; list?: boolean }) {
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

  const model = getGeminiModel(config.models.analysis);

  // --refresh alone re-analyzes whatever no longer matches the current signature,
  // --all widens that to everything, and naming a file always re-analyzes just
  // that file — asking for it by name is already an explicit request.
  let selectionFor: (kind: AnalyzeKind) => SyncOptions;

  if (typeof options.refresh === 'string') {
    const file = options.refresh;
    selectionFor = () => ({ file });
  } else if (options.refresh && options.all) {
    if (!options.force && !(await confirmRefreshAll())) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }
    selectionFor = () => ({ all: true });
  } else if (options.refresh) {
    selectionFor = (kind) => ({ stale: analysisSignature(config, kind, model.id) });
  } else {
    selectionFor = () => ({});
  }

  // Discover and register all media types, then run them through one shared pipeline.
  const items = [
    ...await syncVideos(db, config, selectionFor('video')),
    ...await syncMusic(db, config, selectionFor('music')),
    ...await syncVoiceovers(db, config, selectionFor('voiceover')),
  ];

  const { totalCost } = await runAnalysisPipeline(db, config, model, items);

  console.log(chalk.dim(`Total cost: ${formatCost(totalCost)}`));
}
