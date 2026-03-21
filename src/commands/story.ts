import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { eq, desc } from 'drizzle-orm';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, type AssistantMessage } from '@mariozechner/pi-ai';
import { initDb } from '../db/index.js';
import {
  videos,
  videoSummaries,
  projectContext,
  stories,
  music,
  musicSummaries,
} from '../db/schema.js';
import { loadProjectConfig, serializeVideoSummary, serializeMusicSummary, readProjectFile } from '../utils/project.js';
import {
  storySystemPrompt,
  storyContextPrompt,
} from '../prompts/index.js';
import type { TimelineItem } from '../schemas/timeline-items.js';
import { extractFileContentFromToolResults, limitVideoFilesInContext } from '../utils/agent-context.js';
import { getStoryTools } from './tools.js';
import { renderTimeline } from '../utils/render-timeline.js';

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  const totalSec = Math.round(seconds);
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${totalSec}s`;
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

function countItemsByType(items: Array<{ type: string }>): { clips: number; overlays: number; audio: number } {
  return {
    clips: items.filter(i => i.type === 'clip').length,
    overlays: items.filter(i => i.type === 'overlay').length,
    audio: items.filter(i => i.type === 'audio').length,
  };
}

function formatItemCounts(counts: { clips: number; overlays: number; audio: number }): string {
  const parts: string[] = [];
  if (counts.clips > 0) parts.push(`${counts.clips} clip${counts.clips !== 1 ? 's' : ''}`);
  if (counts.overlays > 0) parts.push(`${counts.overlays} overlay${counts.overlays !== 1 ? 's' : ''}`);
  if (counts.audio > 0) parts.push(`${counts.audio} audio`);
  return parts.join(', ') || 'nothing';
}

export async function storyCommand(
  name?: string,
  options: { new?: boolean; list?: boolean; hint?: string; intro?: boolean } = {},
) {
  const config = loadProjectConfig();
  const db = await initDb();
  const agentInstructions = readProjectFile('AGENTS.md');
  const styleReference = readProjectFile('STYLE.md');

  // --list: show all stories and exit
  if (options.list) {
    const allStories = db.select().from(stories).orderBy(desc(stories.id)).all();
    if (allStories.length === 0) {
      console.log(chalk.dim('No stories yet. Run "montai story" to create one.'));
    } else {
      for (const s of allStories) {
        let status: string;
        if (s.timeline) {
          const items = JSON.parse(s.timeline) as Array<{ type: string }>;
          status = chalk.green(formatItemCounts(countItemsByType(items)));
        } else {
          status = chalk.dim('empty');
        }
        const ago = formatTimeAgo(s.updatedAt);
        console.log(`  ${chalk.cyan(s.name)}  ${s.title}  [${status}]  ${chalk.dim(ago)}`);
      }
    }
    return;
  }

  // Load video data
  const allVideos = db.select().from(videos).all();
  const allSummaries = db.select().from(videoSummaries).all();

  if (allSummaries.length === 0) {
    console.log(chalk.red('No video summaries found. Run "montai analyze" first.'));
    return;
  }

  const videoSummaryData = allSummaries.map((s) => {
    const video = allVideos.find((v) => v.id === s.videoId);
    return {
      videoId: s.videoId,
      filename: video?.filename ?? 'unknown',
      summary: serializeVideoSummary(s),
    };
  });

  // Load music data
  const allMusic = db.select().from(music).all();
  const allMusicSummaries = db.select().from(musicSummaries).all();
  const musicSummaryData = allMusicSummaries.map((s) => {
    const track = allMusic.find((m) => m.id === s.musicId);
    return {
      musicId: s.musicId,
      filename: track?.filename ?? 'unknown',
      summary: serializeMusicSummary(s),
    };
  });

  const context = db.select().from(projectContext).get();
  const facts = context?.facts ?? null;

  // Resolve story: by name, or latest, or create new
  let story: typeof stories.$inferSelect | undefined;

  if (options.new) {
    // Force create new — story will be created by updateStoryline tool
    story = undefined;
  } else if (name) {
    story = db.select().from(stories).where(eq(stories.name, name)).get();
    if (!story) {
      console.log(chalk.red(`Story "${name}" not found.`));
      return;
    }
  } else {
    // Get latest story, or create new if none exist
    story = db.select().from(stories).orderBy(desc(stories.id)).get();
  }

  if (story) {
    console.log(chalk.blue(`Resuming story: ${story.title} (${story.name})`));
  } else {
    console.log(chalk.blue('Starting new story...'));
  }

  // Set up agent
  const model = getModel('google', config.models.editing as Parameters<typeof getModel>[1]);
  const spinner = ora({ text: 'Thinking...', discardStdin: false });
  if (options.intro !== false) {
    spinner.start();
  }

  const musicNames = new Map(allMusic.map((m) => [m.id, m.filename]));

  // In-memory state
  const toolsCtx = {
    db,
    config,
    allVideos,
    allSummaries,
    allMusic,
    allMusicSummaries,
    currentStoryId: story?.id ?? null,
    currentStoryName: story?.name ?? null,
    currentItems: [] as TimelineItem[],
  };

  // Restore raw items from stored timeline on resume
  if (story?.timeline) {
    try {
      toolsCtx.currentItems = JSON.parse(story.timeline) as TimelineItem[];
    } catch {
      // Ignore parse errors from old expanded format
    }
  }

  let totalCost = 0;

  const { tools: allTools, resetWatchCount } = getStoryTools(toolsCtx);

  // Create agent
  const agent = new Agent({
    initialState: {
      systemPrompt: storySystemPrompt(config.language, config.effects.languages, agentInstructions),
      model,
    },
    getApiKey: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    transformContext: async (messages) => limitVideoFilesInContext(extractFileContentFromToolResults(messages)),
  });

  agent.setTools(allTools);

  let lastAssistantText = '';
  let lastToolArgs: Record<string, unknown> = {};

  agent.subscribe((event) => {
    try {
      switch (event.type) {
        case 'turn_start':
          spinner.stop();
          resetWatchCount();
          spinner.text = 'Thinking...';
          spinner.start();
          break;
        case 'tool_execution_start':
          lastToolArgs = event.args as Record<string, unknown>;
          spinner.text = `${event.toolName}...`;
          break;
        case 'tool_execution_end': {
          spinner.stop();

          if (event.isError) {
            console.log(`  ${chalk.red('✗')} ${chalk.red(event.toolName)}: failed`);
            spinner.text = 'Thinking...';
            spinner.start();
            break;
          }

          const check = chalk.green('✓');
          const toolLabel = chalk.green(event.toolName);

          switch (event.toolName) {
            case 'updateStoryline': {
              const title = lastToolArgs.title as string;
              const storyName = lastToolArgs.name as string;
              const narrative = lastToolArgs.narrative as string;
              console.log(`  ${check} ${toolLabel}: ${title} (${storyName})`);
              for (const line of narrative.split('\n')) {
                console.log(chalk.dim(`    ${line}`));
              }
              console.log('');
              break;
            }
            case 'watchSegment': {
              const videoId = lastToolArgs.videoId as number;
              const startSec = lastToolArgs.startSeconds as number;
              const endSec = lastToolArgs.endSeconds as number;
              const dur = formatDuration(endSec - startSec);
              console.log(`  ${check} ${toolLabel}: video ${videoId} (${formatTimestamp(startSec)} - ${formatTimestamp(endSec)}, ${dur})`);
              break;
            }
            case 'updateTimeline': {
              const deleteCount = lastToolArgs.deleteCount as number;
              const newItems = (lastToolArgs.items ?? []) as Array<{ type: string }>;
              const addedCounts = countItemsByType(newItems);
              const hasAdded = newItems.length > 0;
              const hasDeleted = deleteCount !== 0;

              let summary: string;
              if (deleteCount === -1) {
                summary = `replaced with ${formatItemCounts(addedCounts)}`;
              } else if (hasAdded && hasDeleted) {
                summary = `updated ${formatItemCounts(addedCounts)}`;
              } else if (hasAdded) {
                summary = `added ${formatItemCounts(addedCounts)}`;
              } else if (hasDeleted) {
                summary = `deleted ${deleteCount} item${deleteCount !== 1 ? 's' : ''}`;
              } else {
                summary = 'no changes';
              }

              console.log(`  ${check} ${toolLabel}: ${summary}`);
              break;
            }
            case 'getVideoSummary': {
              const videoId = lastToolArgs.videoId as number;
              console.log(`  ${check} ${toolLabel}: video ${videoId}`);
              break;
            }
            default:
              console.log(`  ${check} ${toolLabel}`);
          }

          spinner.text = 'Thinking...';
          spinner.start();
          break;
        }
        case 'turn_end': {
          spinner.stop();
          const msg = event.message;
          if (msg && 'usage' in msg) {
            const assistantMsg = msg as AssistantMessage;
            totalCost += assistantMsg.usage.cost.total;
            if (assistantMsg.stopReason === 'error') {
              const raw = assistantMsg.errorMessage ?? 'unknown error';
              try {
                const parsed = JSON.parse(raw);
                const inner = parsed?.error ?? parsed;
                const detail = inner.message ?? raw;
                console.log(chalk.red(`  Error from Gemini API: ${detail}`));
              } catch {
                console.log(chalk.red(`  Error: ${raw}`));
              }
            }
          }
          // Collect assistant text for display after agent stops
          if (msg && 'content' in msg && Array.isArray(msg.content)) {
            const text = (msg.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text')
              .map((c) => c.text ?? '')
              .join('');
            if (text) {
              lastAssistantText = text;
            }
          }
          break;
        }
        case 'agent_end':
          break;
      }
    } catch (err) {
      spinner.stop();
      console.log(chalk.red(`  Subscriber error: ${err}`));
    }
  });

  // Catch unhandled rejections from agent internals (the agentLoop async IIFE
  // has no error handling — if the Gemini API throws before streaming starts,
  // the rejection is unhandled and would terminate the process in Node >= 15).
  const rejectionHandler = (reason: unknown) => {
    spinner.stop();
    console.log(chalk.red(`  Unhandled rejection: ${reason}`));
    console.log(chalk.dim('  You can retry or give different instructions.'));
  };
  process.on('unhandledRejection', rejectionHandler);

  // Build context prompt (project info only, no instructions)
  const contextMessage = storyContextPrompt(videoSummaryData, facts, {
    storyline: story?.storyline ?? undefined,
    timelineItems: toolsCtx.currentItems.length > 0 ? JSON.stringify(toolsCtx.currentItems, null, 2) : null,
    styleReference,
    musicSummaries: musicSummaryData,
  });

  // Helper to run agent and display response, catching errors
  async function runAgent(message: string): Promise<void> {
    try {
      await agent.prompt(message);
      await agent.waitForIdle();
    } catch (err) {
      spinner.stop();
      console.log(chalk.red(`\n  Agent error: ${err}`));
      console.log(chalk.dim('  You can retry or give different instructions.'));
    }
    spinner.stop();

    if (lastAssistantText) {
      console.log(`\n${lastAssistantText.trimEnd()}`);
      lastAssistantText = '';
    }

    const timelineLines = renderTimeline(
      toolsCtx.currentItems,
      process.stdout.columns || 80,
      musicNames,
      toolsCtx.currentStoryName ?? undefined,
    );
    if (timelineLines.length > 0) {
      console.log('');
      for (const line of timelineLines) {
        console.log(line);
      }
    }
  }

  // Inject context and hint as standalone user messages (no response triggered)
  const userMsg = (text: string) => ({ role: 'user' as const, content: text, timestamp: Date.now() });
  agent.appendMessage(userMsg(contextMessage));
  if (options.hint) {
    agent.appendMessage(userMsg(`Direction from the user: ${options.hint}`));
  }

  // Run initial prompt (or skip with --no-intro)
  if (options.intro === false) {
    // Print timeline if available
    const timelineLines = renderTimeline(
      toolsCtx.currentItems,
      process.stdout.columns || 80,
      musicNames,
      toolsCtx.currentStoryName ?? undefined,
    );
    if (timelineLines.length > 0) {
      for (const line of timelineLines) {
        console.log(line);
      }
    }
  } else {
    agent.setTools([]);
    const introInstruction = story?.storyline
      ? 'Briefly introduce the current storyline and timeline state, then wait for my direction.'
      : 'Briefly introduce what these source videos contain and wait for my direction before proceeding.';
    await runAgent(introInstruction);
  }
  agent.setTools(allTools);

  // Interactive loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (prompt: string): Promise<string | null> => {
    return new Promise((resolve) => {
      rl.once('close', () => resolve(null));
      rl.question(prompt, (answer) => {
        rl.removeAllListeners('close');
        resolve(answer);
      });
    });
  };

  try {
    while (true) {
      const userInput = await askQuestion(chalk.green('\n> '));

      if (userInput === null) {
        // readline closed (ctrl-c, ctrl-d)
        break;
      }
      if (!userInput.trim()) continue;
      if (['exit', 'quit', 'q'].includes(userInput.trim().toLowerCase())) break;

      spinner.text = 'Thinking...';
      spinner.start();

      await runAgent(userInput);
    }
  } finally {
    rl.close();
  }

  process.removeListener('unhandledRejection', rejectionHandler);

  console.log(chalk.dim(`\nTotal cost: $${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}`));

  if (toolsCtx.currentStoryId) {
    const finalStory = db.select().from(stories).where(eq(stories.id, toolsCtx.currentStoryId)).get();
    if (finalStory) {
      console.log(chalk.green(`Story saved: ${finalStory.title} (${finalStory.name})`));
      if (finalStory.timeline) {
        const cmd = chalk.bold.cyan;
        console.log(chalk.cyan(`You can ${cmd('montai preview')}, ${cmd('montai export')}, or ${cmd(`montai render ${finalStory.name}`)}.`));
      }
    }
  }
}
