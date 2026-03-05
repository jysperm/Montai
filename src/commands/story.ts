import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { eq, desc } from 'drizzle-orm';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, type AssistantMessage, type FileContent, type TextContent } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { initDb } from '../db/index.js';
import {
  videos,
  videoSummaries,
  projectContext,
  stories,
} from '../db/schema.js';
import { loadProjectConfig, serializeVideoSummary } from '../utils/project.js';
import { langName } from '../prompts/index.js';
import { uploadVideoToGemini } from '../gemini/upload.js';
import { transcodeForUpload } from '../utils/transcode.js';
import {
  storySystemPrompt,
  storyUserPrompt,
  storyResumePrompt,
} from '../prompts/index.js';
import {
  StoryTimelineItemSchema,
  expandStoryTimeline,
  spliceTimelineItems,
  type StoryTimelineItem,
} from '../schemas/story-timeline.js';
import { extractFileContentFromToolResults, limitVideoFilesInContext } from '../utils/agent-context.js';
import { z } from 'zod';

const MAX_VIDEO_FILES_PER_TURN = 10;

export async function storyCommand(
  name?: string,
  options: { new?: boolean; list?: boolean; hint?: string } = {},
) {
  const config = loadProjectConfig();
  const db = await initDb();

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

  const context = db.select().from(projectContext).get();
  const facts = context?.facts ?? null;

  // Resolve story: by name, or latest, or create new
  let story: typeof stories.$inferSelect | undefined;

  if (options.new) {
    // Force create new — story will be created by update_storyline tool
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
  const spinner = ora({ text: 'Thinking...', discardStdin: false }).start();

  // In-memory state
  let currentStoryId: number | null = story?.id ?? null;
  let currentItems: StoryTimelineItem[] = [];

  // If resuming with a timeline, try to recover items from the expanded timeline
  // (We don't store raw items separately — the expanded timeline is stored)

  let watchCountThisTurn = 0;
  let totalCost = 0;

  // Define tools
  const updateStorylineTool = {
    name: 'update_storyline',
    label: 'Update Storyline',
    description: `Save the current storyline. First call creates the story, subsequent calls update it. All fields must be in ${langName(config.intermediateLanguage)}.`,
    parameters: Type.Object({
      name: Type.String({ description: 'Short kebab-case identifier (e.g. "lantern-festival")' }),
      title: Type.String({ description: `Human-readable title for the video, in ${langName(config.intermediateLanguage)}` }),
      narrative: Type.String({ description: `Free-form markdown describing the edit plan, in ${langName(config.intermediateLanguage)}` }),
    }),
    async execute(
      _toolCallId: string,
      params: { name: string; title: string; narrative: string },
    ) {
      const now = new Date().toISOString();

      if (currentStoryId) {
        db.update(stories)
          .set({
            name: params.name,
            title: params.title,
            storyline: params.narrative,
            updatedAt: now,
          })
          .where(eq(stories.id, currentStoryId))
          .run();
      } else {
        const result = db.insert(stories)
          .values({
            name: params.name,
            title: params.title,
            storyline: params.narrative,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        currentStoryId = result.id;
      }

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Storyline saved: "${params.title}" (${params.name})`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const updateTimelineTool = {
    name: 'update_timeline',
    label: 'Update Timeline',
    description: `Update the timeline using splice semantics. index=0 + deleteCount=-1 for full replacement. Overlay text must be in ${config.effects.languages.map(langName).join(' and ')}.`,
    parameters: Type.Object({
      index: Type.Number({ description: 'Position to start modifying' }),
      deleteCount: Type.Number({ description: 'Number of items to remove (-1 = all from index)' }),
      items: Type.Optional(Type.Array(Type.Any(), { description: 'New items to insert at the position' })),
    }),
    async execute(
      _toolCallId: string,
      params: { index: number; deleteCount: number; items?: unknown[] },
    ) {
      // Validate new items
      let newItems: StoryTimelineItem[] = [];
      if (params.items && params.items.length > 0) {
        try {
          newItems = z.array(StoryTimelineItemSchema).parse(params.items);
        } catch (err) {
          const errorText: TextContent = {
            type: 'text' as const,
            text: `Item validation failed: ${err}`,
          };
          return { content: [errorText], details: {}, isError: true };
        }
      }

      // Validate overlay clip references against current clip count
      const allItems = spliceTimelineItems(currentItems, params.index, params.deleteCount, newItems);
      const clipCount = allItems.filter((i) => i.type === 'clip').length;
      for (const item of allItems) {
        if (item.type === 'overlay') {
          const endClip = item.endClip ?? item.startClip;
          if (item.startClip >= clipCount || endClip >= clipCount) {
            const errorText: TextContent = {
              type: 'text' as const,
              text: `Error: overlay "${item.text}" references clip index ${item.startClip}/${endClip} but there are only ${clipCount} clips (0-${clipCount - 1}). Fix the startClip/endClip values.`,
            };
            return { content: [errorText], details: {}, isError: true };
          }
        }
      }

      // Apply splice
      currentItems = allItems;

      // Expand and store
      if (!currentStoryId) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: 'Error: Call update_storyline first to create a story before updating the timeline.',
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const expanded = expandStoryTimeline(currentItems, config, getCurrentStoryName(), allVideos);
      const now = new Date().toISOString();

      db.update(stories)
        .set({
          timeline: JSON.stringify(expanded),
          updatedAt: now,
        })
        .where(eq(stories.id, currentStoryId))
        .run();

      const finalClipCount = currentItems.filter((i) => i.type === 'clip').length;
      const overlayCount = currentItems.filter((i) => i.type === 'overlay').length;
      const textContent: TextContent = {
        type: 'text' as const,
        text: `Timeline updated: ${currentItems.length} items (${finalClipCount} clips, ${overlayCount} overlays)`,
      };
      return { content: [textContent], details: {} };
    },
  };

  function getCurrentStoryName(): string {
    if (currentStoryId) {
      const row = db.select({ name: stories.name }).from(stories).where(eq(stories.id, currentStoryId)).get();
      return row?.name ?? 'untitled';
    }
    return 'untitled';
  }

  const watchSegmentTool = {
    name: 'watch_segment',
    label: 'Watch Segment',
    description: `Re-watch a specific segment of a video to verify cut points. Maximum ${MAX_VIDEO_FILES_PER_TURN} segments per turn.`,
    parameters: Type.Object({
      videoId: Type.Number({ description: 'The video ID' }),
      startSeconds: Type.Number({ description: 'Start time in seconds' }),
      endSeconds: Type.Number({ description: 'End time in seconds' }),
    }),
    async execute(
      _toolCallId: string,
      params: { videoId: number; startSeconds: number; endSeconds: number },
    ) {
      watchCountThisTurn++;
      if (watchCountThisTurn > MAX_VIDEO_FILES_PER_TURN) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: You have already watched ${MAX_VIDEO_FILES_PER_TURN} segments this turn. Wait for the next turn to watch more segments.`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const video = allVideos.find((v) => v.id === params.videoId);
      if (!video) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: Video ${params.videoId} not found`,
        };
        return { content: [errorText], details: {} };
      }

      try {
        const transcoded = await transcodeForUpload(video.id, video.path);
        const fileUri = await uploadVideoToGemini(video.id, transcoded.path);
        const fileContent: FileContent = {
          type: 'file',
          uri: fileUri,
          mimeType: 'video/mp4',
          videoMetadata: {
            startOffset: `${params.startSeconds}s`,
            endOffset: `${params.endSeconds}s`,
          },
        };
        const textContent: TextContent = {
          type: 'text' as const,
          text: `Video segment from ${video.filename} (${params.startSeconds}s-${params.endSeconds}s) is now in context.`,
        };
        return { content: [textContent, fileContent], details: {} };
      } catch (err) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error watching segment: ${err}`,
        };
        return { content: [errorText], details: {} };
      }
    },
  };

  const getVideoSummaryTool = {
    name: 'get_video_summary',
    label: 'Get Video Summary',
    description: 'Retrieve the stored analysis summary for a video.',
    parameters: Type.Object({
      videoId: Type.Number({ description: 'The video ID' }),
    }),
    async execute(
      _toolCallId: string,
      params: { videoId: number },
    ) {
      const summary = allSummaries.find((s) => s.videoId === params.videoId);
      const textContent: TextContent = {
        type: 'text' as const,
        text: summary
          ? `Summary for video ${params.videoId}:\n${serializeVideoSummary(summary)}`
          : `No summary found for video ${params.videoId}`,
      };
      return { content: [textContent], details: {} };
    },
  };

  // Create agent
  const agent = new Agent({
    initialState: {
      systemPrompt: storySystemPrompt(config.intermediateLanguage, config.effects.languages),
      model,
    },
    getApiKey: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    transformContext: async (messages) => limitVideoFilesInContext(extractFileContentFromToolResults(messages)),
  });

  agent.setTools([updateStorylineTool, updateTimelineTool, watchSegmentTool, getVideoSummaryTool]);

  let turn = 0;
  let lastAssistantText = '';

  agent.subscribe((event) => {
    try {
      switch (event.type) {
        case 'turn_start':
          spinner.stop();
          turn++;
          watchCountThisTurn = 0;
          spinner.text = `Turn ${turn}: thinking...`;
          spinner.start();
          break;
        case 'tool_execution_start':
          spinner.stop();
          console.log(chalk.dim(`  [${event.toolName}] ${JSON.stringify(event.args).slice(0, 200)}`));
          spinner.text = `Turn ${turn}: ${event.toolName}...`;
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
    let timelineItemsJson: string | null = null;
    // We don't store raw items separately, so we pass null for timeline items on resume
    // The expanded timeline is in the story record but we don't reverse-expand it
    initialMessage = storyResumePrompt(
      story.storyline,
      timelineItemsJson,
      videoSummaryData,
      facts,
    );
  } else {
    // New story
    initialMessage = storyUserPrompt(videoSummaryData, facts, options.hint ?? '');
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
  }

  // Run initial prompt
  await runAgent(initialMessage);

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

  if (currentStoryId) {
    const finalStory = db.select().from(stories).where(eq(stories.id, currentStoryId)).get();
    if (finalStory) {
      console.log(chalk.green(`Story saved: "${finalStory.title}" (${finalStory.name})`));
      if (finalStory.timeline) {
        console.log(chalk.cyan(`  Preview:  montai remotion studio ${finalStory.name}`));
        console.log(chalk.cyan(`  Render:   montai remotion render ${finalStory.name}`));
        console.log(chalk.cyan(`  Export:   montai export ${finalStory.name}`));
      }
      console.log(chalk.cyan(`  Resume:   montai story ${finalStory.name}`));
    }
  }
}
