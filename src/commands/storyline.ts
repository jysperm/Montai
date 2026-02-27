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

export async function storylineCommand(options: { hint?: string }) {
  const config = loadProjectConfig();
  const db = getDb();

  const allSummaries = db.select().from(videoSummaries).all();
  if (allSummaries.length === 0) {
    console.log(chalk.red('No video summaries found. Run "cutflow analyze" first.'));
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
  const storylineText = extractJson(getTextContent(result));

  let title = 'Untitled Storyline';
  let codename = 'untitled';

  try {
    const parsed = JSON.parse(storylineText);
    title = parsed.title ?? title;
    codename = parsed.codename ?? codename;
  } catch {
    // keep defaults
  }

  const row = db
    .insert(storylines)
    .values({
      codename,
      title,
      content: storylineText,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();

  spinner.succeed(`Storyline created: "${title}" (${codename})`);

  try {
    const parsed = JSON.parse(storylineText);
    if (parsed.acts) {
      console.log(chalk.cyan('\nActs:'));
      for (const act of parsed.acts) {
        console.log(`  ${chalk.bold(act.name)}: ${act.description}`);
        console.log(`    Clips: ${act.clips?.length ?? 0}`);
      }
    }
    if (parsed.estimatedDurationSeconds) {
      const mins = Math.floor(parsed.estimatedDurationSeconds / 60);
      const secs = parsed.estimatedDurationSeconds % 60;
      console.log(chalk.cyan(`\nEstimated duration: ${mins}m ${secs}s`));
    }
  } catch {
    // non-critical
  }
}
