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
  storyUserPrompt,
  storyResumePrompt,
} from '../prompts/index.js';
import type { TimelineItem } from '../schemas/timeline-items.js';
import { extractFileContentFromToolResults, limitVideoFilesInContext } from '../utils/agent-context.js';
import { getStoryTools } from './tools.js';
import { renderTimeline } from '../utils/render-timeline.js';

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
        const hasTimeline = s.timeline ? chalk.green('timeline') : chalk.dim('no timeline');
        console.log(`  ${chalk.cyan(s.name)}  ${s.title}  [${hasTimeline}]  ${chalk.dim(s.updatedAt)}`);
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
    console.log(chalk.blue(`Resuming story: "${story.title}" (${story.name})`));
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

  agent.subscribe((event) => {
    try {
      switch (event.type) {
        case 'turn_start':
          spinner.stop();
          resetWatchCount();
          spinner.text = `Thinking...`;
          spinner.start();
          break;
        case 'tool_execution_start':
          spinner.stop();
          console.log(chalk.dim(`  [${event.toolName}] ${JSON.stringify(event.args).slice(0, 200)}`));
          spinner.text = `${event.toolName}...`;
          spinner.start();
          break;
        case 'tool_execution_end':
          if (event.isError) {
            spinner.stop();
            console.log(chalk.red(`  [${event.toolName}] failed`));
            spinner.start();
          }
          break;
        case 'turn_end': {
          spinner.stop();
          const msg = event.message;
          if (msg && 'usage' in msg) {
            const assistantMsg = msg as AssistantMessage;
            const { usage } = assistantMsg;
            totalCost += usage.cost.total;
            const totalInput = usage.input + usage.cacheRead;
            const cacheStr = totalInput > 0 && usage.cacheRead > 0
              ? `, ${Math.round((usage.cacheRead / totalInput) * 100)}% cached`
              : '';
            console.log(chalk.dim(`  Cost: $${usage.cost.total < 0.01 ? usage.cost.total.toFixed(4) : usage.cost.total.toFixed(2)}${cacheStr}`));
            if (assistantMsg.stopReason === 'error') {
              console.log(chalk.red(`  Error: ${assistantMsg.errorMessage ?? 'unknown error'}`));
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

  // Build initial prompt
  let initialMessage: string;
  if (story?.storyline) {
    // Resume: inject current state
    const timelineItemsJson = toolsCtx.currentItems.length > 0 ? JSON.stringify(toolsCtx.currentItems, null, 2) : null;
    initialMessage = storyResumePrompt(
      story.storyline,
      timelineItemsJson,
      videoSummaryData,
      facts,
      styleReference,
      musicSummaryData,
    );
  } else {
    // New story
    initialMessage = storyUserPrompt(videoSummaryData, facts, options.hint ?? '', styleReference, musicSummaryData);
  }

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
    );
    if (timelineLines.length > 0) {
      console.log('');
      for (const line of timelineLines) {
        console.log(line);
      }
    }
  }

  // Run initial prompt (or skip with --no-intro)
  let pendingContext: string | null = null;
  if (options.intro === false) {
    // Defer context injection until the user's first message
    pendingContext = initialMessage;

    // Print timeline if available
    const timelineLines = renderTimeline(
      toolsCtx.currentItems,
      process.stdout.columns || 80,
      musicNames,
    );
    if (timelineLines.length > 0) {
      for (const line of timelineLines) {
        console.log(line);
      }
    }
  } else {
    agent.setTools([]);
    await runAgent(initialMessage);
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

      let message = userInput;
      if (pendingContext) {
        message = pendingContext + '\n\n---\n\n' + userInput;
        pendingContext = null;
      }
      await runAgent(message);
    }
  } finally {
    rl.close();
  }

  process.removeListener('unhandledRejection', rejectionHandler);

  console.log(chalk.dim(`\nTotal cost: $${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}`));

  if (toolsCtx.currentStoryId) {
    const finalStory = db.select().from(stories).where(eq(stories.id, toolsCtx.currentStoryId)).get();
    if (finalStory) {
      console.log(chalk.green(`Story saved: "${finalStory.title}" (${finalStory.name})`));
      if (finalStory.timeline) {
        const cmd = chalk.bold.cyan;
        console.log(chalk.cyan(`You can ${cmd('montai preview')}, ${cmd('montai export')}, or ${cmd(`montai render ${finalStory.name}`)}.`));
      }
    }
  }
}
