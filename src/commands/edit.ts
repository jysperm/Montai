import chalk from 'chalk';
import ora from 'ora';
import { eq, desc } from 'drizzle-orm';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, type AssistantMessage, type FileContent, type TextContent } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { getDb } from '../db/index.js';
import {
  videos,
  videoSummaries,
  storylines,
  timelines,
} from '../db/schema.js';
import { loadProjectConfig, serializeVideoSummary } from '../utils/project.js';
import { uploadVideoToGemini } from '../gemini/upload.js';
import { transcodeForUpload } from '../utils/transcode.js';
import {
  timelineSystemPrompt,
  timelineUserPrompt,
} from '../prompts/index.js';
import { LLMTimelineSchema, expandTimeline, type LLMTimeline } from '../schemas/timeline.js';
import { extractFileContentFromToolResults, limitVideoFilesInContext } from '../utils/agent-context.js';

const MAX_VIDEO_FILES_PER_TURN = 10;

export async function editCommand(options: { storyline?: string }) {

  const config = loadProjectConfig();
  const db = getDb();

  // Find storyline by ID or codename
  let storyline;
  if (options.storyline) {
    const id = parseInt(options.storyline, 10);
    if (!isNaN(id) && String(id) === options.storyline) {
      storyline = db
        .select()
        .from(storylines)
        .where(eq(storylines.id, id))
        .get();
    }
    if (!storyline) {
      storyline = db
        .select()
        .from(storylines)
        .where(eq(storylines.codename, options.storyline))
        .get();
    }
    if (!storyline) {
      console.log(chalk.red(`Storyline "${options.storyline}" not found.`));
      return;
    }
  } else {
    storyline = db
      .select()
      .from(storylines)
      .orderBy(desc(storylines.id))
      .get();
    if (!storyline) {
      console.log(
        chalk.red('No storylines found. Run "cutflow storyline" first.')
      );
      return;
    }
  }

  console.log(chalk.blue(`Using storyline: "${storyline.title}" (${storyline.codename})`));

  const allVideos = db.select().from(videos).all();
  const allSummaries = db.select().from(videoSummaries).all();

  const videoSummaryData = allSummaries.map((s) => {
    const video = allVideos.find((v) => v.id === s.videoId);
    return {
      videoId: s.videoId,
      filename: video?.filename ?? 'unknown',
      summary: serializeVideoSummary(s),
    };
  });

  const model = getModel('google', config.models.edit as Parameters<typeof getModel>[1]);

  console.log(chalk.blue(`Starting edit agent (${config.models.edit})...`));
  const spinner = ora('Edit agent starting...').start();

  let llmTimeline: LLMTimeline | null = null;

  // Track watch_segment calls per turn
  let watchCountThisTurn = 0;

  // Define tools for the pi-agent-core agent
  const watchSegmentTool = {
    name: 'watch_segment',
    label: 'Watch Segment',
    description:
      `Re-watch a specific segment of a video to verify cut points or refine timing. Video content will be added to context. Maximum ${MAX_VIDEO_FILES_PER_TURN} segments per turn. Plan carefully and record your observations.`,
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
          text: `Error: You have already watched ${MAX_VIDEO_FILES_PER_TURN} segments this turn. Wait for the next turn to watch more segments. Remember to record your observations from the segments you've already watched.`,
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

  const submitTimelineTool = {
    name: 'submit_timeline',
    label: 'Submit Timeline',
    description:
      'Submit the final timeline. Call this when you are satisfied with the edit. The timeline must be a complete JSON object following the Timeline format.',
    parameters: Type.Object({
      timeline: Type.Any({ description: 'The complete Timeline JSON object' }),
    }),
    async execute(
      _toolCallId: string,
      params: { timeline: unknown },
    ) {
      try {
        llmTimeline = LLMTimelineSchema.parse(params.timeline);
      } catch (err) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Timeline validation failed: ${err}`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      // Stop the agent loop — no need for another LLM turn after successful submission
      agent.abort();

      const textContent: TextContent = {
        type: 'text' as const,
        text: 'Timeline submitted successfully. The edit is complete.',
      };
      return { content: [textContent], details: {} };
    },
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: timelineSystemPrompt(config.intermediateLanguage),
      model,
    },
    getApiKey: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    transformContext: async (messages) => limitVideoFilesInContext(extractFileContentFromToolResults(messages)),
  });

  agent.setTools([watchSegmentTool, getVideoSummaryTool, submitTimelineTool]);

  let turn = 0;
  let totalCost = 0;

  agent.subscribe((event) => {
    switch (event.type) {
      case 'turn_start':
        spinner.stop();
        turn++;
        watchCountThisTurn = 0;
        console.log(chalk.cyan(`\n--- Turn ${turn} ---`));
        spinner.text = `Turn ${turn}: waiting for LLM...`;
        spinner.start();
        break;
      case 'tool_execution_start':
        spinner.stop();
        console.log(chalk.dim(`  Tool: ${event.toolName}(${JSON.stringify(event.args)})`));
        spinner.text = `Turn ${turn}: ${event.toolName}...`;
        spinner.start();
        break;
      case 'tool_execution_end':
        if (event.isError) {
          spinner.stop();
          console.log(chalk.red(`  Tool ${event.toolName} failed`));
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
          console.log(chalk.dim(`  Cost: $${usage.cost.total < 0.01 ? usage.cost.total.toFixed(4) : usage.cost.total.toFixed(2)}${cacheStr}, stopReason: ${assistantMsg.stopReason}, input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}`));
          if (assistantMsg.stopReason === 'error') {
            console.log(chalk.red(`  Error: ${assistantMsg.errorMessage ?? 'unknown error'}`));
          }
          // Log content types in the response
          const contentTypes = assistantMsg.content.map((c) => {
            if (c.type === 'text') return `text(${(c as TextContent).text.length} chars)`;
            if (c.type === 'toolCall') return `toolCall(${(c as { toolName?: string }).toolName})`;
            return c.type;
          });
          console.log(chalk.dim(`  Content: [${contentTypes.join(', ')}]`));
        }
        // Print assistant text
        if (msg && 'content' in msg && Array.isArray(msg.content)) {
          const text = (msg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
          if (text) {
            console.log(`  ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`);
          }
        }
        break;
      }
      case 'agent_end':
        break;
    }
  });

  await agent.prompt(
    timelineUserPrompt(storyline.narrative, videoSummaryData)
  );
  await agent.waitForIdle();

  spinner.stop();
  console.log(chalk.dim(`\nTotal agent cost: $${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}`));

  if (!llmTimeline) {
    console.log(chalk.red('Failed to generate timeline.'));
    return;
  }

  console.log(chalk.green('Timeline generated'));

  const finalTimeline = expandTimeline(llmTimeline, config, storyline, allVideos);

  // Store timeline in database
  const result = db
    .insert(timelines)
    .values({
      name: finalTimeline.name,
      storylineId: storyline.id,
      spec: JSON.stringify(finalTimeline),
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();

  console.log(chalk.green(`Timeline saved (ID: ${result.id})`));

  console.log(
    chalk.green(
      `\nEdit complete! ${finalTimeline.clips.length} clips, ` +
        `${finalTimeline.textOverlays.length} overlays`
    )
  );
  console.log(chalk.cyan(`  Preview:  cutflow remotion studio ${finalTimeline.name}`));
  console.log(chalk.cyan(`  Render:   cutflow remotion render ${finalTimeline.name}`));
  console.log(chalk.cyan(`  Export:   cutflow export ${finalTimeline.name}`));
}
