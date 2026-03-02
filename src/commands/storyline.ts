import chalk from 'chalk';
import ora from 'ora';
import { getDb } from '../db/index.js';
import { videoSummaries, projectContext, storylines } from '../db/schema.js';
import { loadProjectConfig, serializeVideoSummary } from '../utils/project.js';
import { storylinePrompt } from '../prompts/index.js';
import { getModel, complete, type TextContent, type AssistantMessage } from '@mariozechner/pi-ai';

function assertComplete(result: AssistantMessage): void {
  if (result.stopReason === 'error') {
    throw new Error(result.errorMessage ?? 'LLM request failed');
  }
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export async function storylineCommand(options: { hint?: string }) {
  const config = loadProjectConfig();
  const db = getDb();

  const allSummaries = db.select().from(videoSummaries).all();
  if (allSummaries.length === 0) {
    console.log(chalk.red('No video summaries found. Run "montai analyze" first.'));
    return;
  }

  const context = db.select().from(projectContext).get();

  const spinner = ora('Generating storyline...').start();

  const prompt = storylinePrompt(
    context?.facts ?? null,
    allSummaries.map((s) => ({ videoId: s.videoId, summary: serializeVideoSummary(s) })),
    options.hint ?? '',
    config.intermediateLanguage
  );

  const model = getModel('google', config.models.storyline as Parameters<typeof getModel>[1]);
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const t0 = Date.now();
  const result = await complete(model, {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now(),
      },
    ],
  }, { apiKey });

  assertComplete(result);
  const elapsed = Date.now() - t0;
  const cost = result.usage.cost.total;
  const storylineText = extractJson(getTextContent(result));

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(storylineText);
  } catch {
    parsed = {};
  }

  const title = typeof parsed.title === 'string' ? parsed.title : 'Untitled Storyline';
  const codename = typeof parsed.codename === 'string' ? parsed.codename : 'untitled';
  const narrative = typeof parsed.narrative === 'string' ? parsed.narrative : storylineText;
  const estimatedDurationSeconds = typeof parsed.estimatedDurationSeconds === 'number' ? parsed.estimatedDurationSeconds : null;

  db.insert(storylines)
    .values({
      codename,
      title,
      narrative,
      estimatedDurationSeconds,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();

  spinner.succeed(`Storyline created: "${title}" (${codename}) (${formatDuration(elapsed)}, ${formatCost(cost)})`);

  console.log(chalk.cyan('\nNarrative:'));
  console.log(narrative);

  if (estimatedDurationSeconds) {
    const mins = Math.floor(estimatedDurationSeconds / 60);
    const secs = estimatedDurationSeconds % 60;
    console.log(chalk.cyan(`\nEstimated duration: ${mins}m ${secs}s`));
  }
}
