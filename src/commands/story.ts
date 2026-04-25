import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { select } from '@inquirer/prompts';
import stringWidth from 'string-width';
import { eq, desc } from 'drizzle-orm';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, type AssistantMessage, type Message } from '@mariozechner/pi-ai';
import { initDb } from '../db/index.js';
import { videos, videoAnalyses, projectContext, stories, music, musicAnalyses, voiceovers, voiceoverAnalyses } from '../db/schema.js';
import { loadProjectConfig, readProjectFile, loadExpandedTimelines } from '../utils/project.js';
import { renderPrompt, languageNames } from '../prompts/index.js';
import { TimelineItemSchema, stripTimelineDefaults, buildComputedTimelineData, type TimelineItem } from '../schemas/timeline-items.js';
import { z } from 'zod';
import { extractFileContentFromToolResults, limitVideoFilesInContext } from '../utils/agent-context.js';
import { formatDuration, formatTimeAgo, formatStoryLine, countItemsByType, formatItemCounts } from '../utils/format.js';
import { formatCost } from '../analyzer/utils.js';
import { logRequest, logStep, logResponse, logToolCall } from '../utils/llm-logging.js';
import { ApiDebugCapture } from '../utils/api-debug.js';
import { getStoryTools } from './tools.js';
import { resolveFeatureFlags } from '../feature-flags.js';
import { renderTimeline } from '../utils/render-timeline.js';
import { exportFcpxmlFiles } from './export.js';
import { preparePublicDir, collectMediaFiles, writeTimelinesJson } from '../remotion/public-dir.js';

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type StoryRow = typeof stories.$inferSelect;
type StorySelection = { action: 'new' } | { action: 'open'; story: StoryRow };

async function selectStoryInteractive(allStories: StoryRow[]): Promise<StorySelection | null> {
  if (!process.stdin.isTTY) return null;

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  try {
    return await select<StorySelection>({
      message: 'Select a story',
      choices: [
        ...allStories.map((s) => ({
          name: formatStoryLine(s),
          value: { action: 'open' as const, story: s },
        })),
        { name: chalk.bold('+ New story'), value: { action: 'new' as const } },
      ],
      loop: false,
      pageSize: Math.min(allStories.length + 1, 15),
      theme: {
        style: {
          highlight: (text: string) => chalk.cyan(stripAnsi(text)),
        },
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      return null;
    }
    throw err;
  }
}

// TUI output convention: each output block adds its own trailing blank line
// (console.log('')) for spacing. The prompt uses '> ' without a leading '\n',
// relying on the previous block's trailing blank line for separation.
// Use console.log for all visible content (ensures trailing '\n'); reserve
// process.stdout.write for cursor/ANSI control only. If a write lacks a
// trailing '\n', readline will erase it when drawing the next prompt.
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
      console.log(chalk.dim(`No stories yet. Run ${chalk.reset.bold('montai story')} to create one.`));
    } else {
      for (const s of allStories) {
        console.log(formatStoryLine(s));
      }
    }
    return;
  }

  // Load video data
  const allVideos = db.select().from(videos).all();
  const allVideoAnalyses = db.select().from(videoAnalyses).all();

  if (allVideoAnalyses.length === 0) {
    console.log(chalk.red(`No video analyses found. Run ${chalk.bold('montai analyze')} first.`));
    return;
  }

  const videoAnalysisData = allVideoAnalyses.map((s) => {
    const video = allVideos.find((v) => v.id === s.videoId);
    return {
      videoId: s.videoId,
      filename: video?.filename ?? 'unknown',
      durationSeconds: video?.durationSeconds ?? 0,
      overview: s.overview,
      location: s.location,
      timeOfDay: s.timeOfDay,
      segments: JSON.parse(s.segments),
      highlights: JSON.parse(s.highlights),
      technicalNotes: s.technicalNotes,
    };
  });

  // Load music data
  const allMusic = db.select().from(music).all();
  const allMusicAnalyses = db.select().from(musicAnalyses).all();
  const musicAnalysisData = allMusicAnalyses.map((s) => {
    const track = allMusic.find((m) => m.id === s.musicId);
    return {
      musicId: s.musicId,
      filename: track?.filename ?? 'unknown',
      overview: s.overview,
      segments: JSON.parse(s.segments),
    };
  });

  // Load generated music for context
  const generatedMusicData = allMusic
    .filter((m) => m.type === 'generated' && m.generationPrompt)
    .map((m) => ({
      musicId: m.id,
      durationSeconds: m.durationSeconds ?? 30,
      prompt: m.generationPrompt!,
    }));

  // Load voiceover data
  const allVoiceoversData = db.select().from(voiceovers).all();
  const allVoiceoverAnalysesData = db.select().from(voiceoverAnalyses).all();
  const voiceoverAnalysisData = allVoiceoverAnalysesData.map((a) => {
    const vo = allVoiceoversData.find((v) => v.id === a.voiceoverId);
    return {
      voiceoverId: a.voiceoverId,
      filename: vo?.filename ?? 'unknown',
      durationSeconds: vo?.durationSeconds ?? 0,
      overview: a.overview,
      transcription: JSON.parse(a.transcription),
    };
  });

  const context = db.select().from(projectContext).get();
  const facts = context?.facts ?? null;

  // Resolve story: by name, interactive pick, or create new
  let story: StoryRow | undefined;

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
    // Interactive selection among existing stories, or create new if none exist
    const allStories = db.select().from(stories).orderBy(desc(stories.updatedAt)).all();
    if (allStories.length === 0) {
      story = undefined;
    } else {
      const selection = await selectStoryInteractive(allStories);
      if (!selection) {
        return;
      }
      story = selection.action === 'open' ? selection.story : undefined;
    }
  }

  if (story) {
    console.log(chalk.green(`Resuming story: ${story.title} ${chalk.cyan(story.name)}`));
    console.log('');
  } else {
    console.log(chalk.blue('Starting new story...'));
  }

  // Set up agent
  const model = getModel('google', config.models.editing as Parameters<typeof getModel>[1]);
  const spinner = ora({ text: 'Thinking...', discardStdin: false });
  if (options.intro !== false) {
    spinner.start();
  }

  // Build music names map dynamically to include newly generated music
  const getMusicNames = () => new Map(toolsCtx.allMusic.map((m) => [
    m.id,
    m.type === 'generated'
      ? `gen:${(m.generationPrompt ?? '').slice(0, 20)}`
      : m.filename,
  ]));

  const features = resolveFeatureFlags(config, {
    hasMusic: allMusic.length > 0,
    hasVoiceovers: allVoiceoversData.length > 0,
  });

  // In-memory state
  const toolsCtx = {
    db,
    config,
    features,
    languageName: languageNames[config.language] ?? config.language,
    overlayLanguageNames: config.effects.languages.map((l) => languageNames[l] ?? l).join(' and '),
    allVideos,
    allVideoAnalyses,
    allMusic,
    allMusicAnalyses,
    allVoiceovers: allVoiceoversData,
    allVoiceoverAnalyses: allVoiceoverAnalysesData,
    currentStoryId: story?.id ?? null,
    currentStoryName: story?.name ?? null,
    currentItems: [] as TimelineItem[],
    agent: null as import('@mariozechner/pi-agent-core').Agent | null,
    timelineVersion: 0,
  };

  // Restore raw items from stored timeline on resume
  if (story?.timeline) {
    try {
      toolsCtx.currentItems = z.array(TimelineItemSchema).parse(JSON.parse(story.timeline));
    } catch {
      // Ignore parse errors from old expanded format
    }
  }

  let totalCost = 0;
  let autoExport = false;
  let autoPreview = false;
  let previewChild: ChildProcess | null = null;
  let linkedMedia = new Set<string>();

  const { tools: allTools, resetWatchCount } = getStoryTools(toolsCtx);

  const apiDebug = new ApiDebugCapture();

  // Create agent
  const agent = new Agent({
    initialState: {
      systemPrompt: renderPrompt('story-system', {
        language: config.language,
        overlayLanguages: config.effects.languages,
        agentInstructions: agentInstructions ?? null,
        features,
      }),
      model,
    },
    getApiKey: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    transformContext: async (messages) => limitVideoFilesInContext(extractFileContentFromToolResults(messages)),
    streamFn: apiDebug.streamFn,
  });

  agent.state.tools = allTools;
  toolsCtx.agent = agent;

  let lastAssistantText = '';
  const toolArgsMap = new Map<string, Record<string, unknown>>();
  let hadToolOutput = false;
  let debugStep = 0;
  let debugTurnStartTime = 0;

  agent.subscribe((event) => {
    try {
      switch (event.type) {
        case 'turn_start':
          debugStep++;
          debugTurnStartTime = Date.now();
          logRequest(
            agent.state.messages as Message[],
            agent.state.systemPrompt,
          );
          spinner.stop();
          resetWatchCount();
          spinner.text = 'Thinking...';
          spinner.start();
          break;
        case 'message_end': {
          const msg = event.message;
          if (msg && msg.role === 'assistant' && 'usage' in msg) {
            const assistantMsg = msg as AssistantMessage;
            logStep({
              step: debugStep,
              model: assistantMsg.model,
              usage: assistantMsg.usage,
              durationMs: Date.now() - debugTurnStartTime,
            });
            logResponse(assistantMsg);
          }
          break;
        }
        case 'tool_execution_start':
          toolArgsMap.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
          spinner.text = `${event.toolName}...`;
          break;
        case 'tool_execution_end': {
          spinner.stop();
          const toolArgs = toolArgsMap.get(event.toolCallId) ?? {};
          toolArgsMap.delete(event.toolCallId);
          logToolCall(event.toolName, toolArgs, event.result);

          // Check both framework-level isError (from thrown exceptions) and
          // tool-level isError (returned in result) — pi-agent-core only sets
          // event.isError for exceptions, not for { isError: true } returns.
          const toolResultIsError = event.isError ||
            (event.result && typeof event.result === 'object' && 'isError' in event.result && event.result.isError);

          if (toolResultIsError) {
            const errorContent = (event.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
            const errorSummary = errorContent
              ? errorContent.split('\n').filter(Boolean).slice(0, 2).join('; ').slice(0, 200)
              : 'failed';
            console.log(`  ${chalk.red('✗')} ${chalk.red(event.toolName)}: ${errorSummary}`);
            spinner.text = 'Thinking...';
            spinner.start();
            break;
          }

          hadToolOutput = true;
          const check = chalk.green('✓');
          const toolLabel = chalk.green(event.toolName);

          switch (event.toolName) {
            case 'updateStoryline': {
              const title = toolArgs.title as string | undefined;
              const storyName = toolArgs.name as string | undefined;
              const narrative = toolArgs.narrative as string | undefined;
              console.log(`  ${check} ${toolLabel}: ${title ?? ''}  ${chalk.cyan(storyName ?? '')}`);
              if (narrative) {
                for (const line of narrative.split('\n')) {
                  console.log(chalk.dim(`    ${line}`));
                }
              }
              console.log('');
              break;
            }
            case 'watchSegment': {
              const videoId = toolArgs.videoId as number;
              const startSec = toolArgs.startSeconds as number;
              const endSec = toolArgs.endSeconds as number;
              const dur = formatDuration(endSec - startSec);
              console.log(`  ${check} ${toolLabel}: video ${videoId} (${formatTimestamp(startSec)} - ${formatTimestamp(endSec)}, ${dur})`);
              break;
            }
            case 'updateTimeline': {
              const deleteCount = toolArgs.deleteCount as number;
              const newItems = (toolArgs.items ?? []) as Array<{ type: string }>;
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
            case 'getVideoAnalysis': {
              const videoId = toolArgs.videoId as number;
              console.log(`  ${check} ${toolLabel}: video ${videoId}`);
              break;
            }
            case 'getMusicAnalysis': {
              const musicId = toolArgs.musicId as number;
              console.log(`  ${check} ${toolLabel}: music ${musicId}`);
              break;
            }
            case 'getVoiceoverAnalysis': {
              const voiceoverId = toolArgs.voiceoverId as number;
              console.log(`  ${check} ${toolLabel}: voiceover ${voiceoverId}`);
              break;
            }
            case 'generateMusic': {
              const prompt = toolArgs.prompt as string;
              const resultText = (event.result as { content: { text: string }[] })?.content?.[0]?.text ?? '';
              const idMatch = resultText.match(/Music ID: (\d+)/);
              const musicId = idMatch ? idMatch[1] : '?';
              console.log(`  ${check} ${toolLabel}: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}" → musicId ${musicId}`);
              break;
            }
            case 'listStories': {
              console.log(`  ${check} ${toolLabel}`);
              break;
            }
            case 'switchStory': {
              const targetName = toolArgs.name as string | undefined;
              const isNew = toolArgs.new as boolean | undefined;
              if (isNew) {
                console.log(`  ${check} ${toolLabel}: new story`);
              } else {
                console.log(`  ${check} ${toolLabel}: ${chalk.cyan(targetName ?? '?')}`);
              }
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
              const dumpPath = apiDebug.dumpError(assistantMsg);
              if (dumpPath) {
                console.log(chalk.dim(`  Debug dump written to ${dumpPath}`));
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
  // When timeline exists, split videos/music into referenced (full) and unreferenced (summary)
  const hasTimeline = toolsCtx.currentItems.length > 0;
  let fullVideoAnalyses = videoAnalysisData;
  let summaryVideoAnalyses: typeof videoAnalysisData = [];
  let fullMusicAnalyses = musicAnalysisData;
  let summaryMusicAnalyses: typeof musicAnalysisData = [];
  let fullVoiceoverAnalyses = voiceoverAnalysisData;
  let summaryVoiceoverAnalyses: typeof voiceoverAnalysisData = [];

  if (hasTimeline) {
    const referencedVideoIds = new Set(
      toolsCtx.currentItems.filter((i) => i.type === 'clip').map((i) => (i as { videoId: number }).videoId),
    );
    fullVideoAnalyses = videoAnalysisData.filter((v) => referencedVideoIds.has(v.videoId));
    summaryVideoAnalyses = videoAnalysisData.filter((v) => !referencedVideoIds.has(v.videoId));

    const hasMusicItems = toolsCtx.currentItems.some((i) => i.type === 'music');
    if (hasMusicItems) {
      const referencedMusicIds = new Set(
        toolsCtx.currentItems.filter((i) => i.type === 'music').map((i) => (i as { musicId?: number }).musicId).filter((id): id is number => id != null),
      );
      fullMusicAnalyses = musicAnalysisData.filter((m) => referencedMusicIds.has(m.musicId));
      summaryMusicAnalyses = musicAnalysisData.filter((m) => !referencedMusicIds.has(m.musicId));
    }

    const hasVoiceoverItems = toolsCtx.currentItems.some((i) => i.type === 'voiceover');
    if (hasVoiceoverItems) {
      const referencedVoiceoverIds = new Set(
        toolsCtx.currentItems.filter((i) => i.type === 'voiceover').map((i) => (i as { voiceoverId?: number }).voiceoverId).filter((id): id is number => id != null),
      );
      fullVoiceoverAnalyses = voiceoverAnalysisData.filter((v) => referencedVoiceoverIds.has(v.voiceoverId));
      summaryVoiceoverAnalyses = voiceoverAnalysisData.filter((v) => !referencedVoiceoverIds.has(v.voiceoverId));
    }
  }

  const contextMessage = renderPrompt('story-context', {
    fullVideoAnalyses: fullVideoAnalyses.length > 0 ? fullVideoAnalyses : null,
    summaryVideoAnalyses: summaryVideoAnalyses.length > 0 ? summaryVideoAnalyses : null,
    facts: facts ?? null,
    storyline: story?.storyline ?? null,
    timelineItems: toolsCtx.currentItems.length > 0 ? JSON.stringify(stripTimelineDefaults(toolsCtx.currentItems), null, 2) : null,
    computedTimeline: toolsCtx.currentItems.length > 0 ? renderPrompt('computed-timeline', buildComputedTimelineData(toolsCtx.currentItems)) : null,
    styleReference: styleReference ?? null,
    fullVoiceoverAnalyses: features.voiceover && fullVoiceoverAnalyses.length > 0 ? fullVoiceoverAnalyses : null,
    summaryVoiceoverAnalyses: features.voiceover && summaryVoiceoverAnalyses.length > 0 ? summaryVoiceoverAnalyses : null,
    fullMusicAnalyses: features.music && fullMusicAnalyses.length > 0 ? fullMusicAnalyses : null,
    summaryMusicAnalyses: features.music && summaryMusicAnalyses.length > 0 ? summaryMusicAnalyses : null,
    generatedMusic: features.musicGeneration && generatedMusicData.length > 0 ? generatedMusicData : null,
  });

  // Helper to run agent and display response, catching errors
  async function runAgent(message: string): Promise<void> {
    hadToolOutput = false;
    try {
      await agent.prompt(message);
      await agent.waitForIdle();
    } catch (err) {
      spinner.stop();
      console.log('');
      console.log(chalk.red(`  Agent error: ${err}`));
      console.log(chalk.dim('  You can retry or give different instructions.'));
      console.log('');
    }
    spinner.stop();

    if (lastAssistantText) {
      if (hadToolOutput) {
        console.log('');
      }
      const formatted = lastAssistantText.trimEnd().replace(/\*\*(.+?)\*\*/g, (_, text) => chalk.bold(text));
      console.log(formatted);
      if (!formatted.endsWith('\n')) {
        console.log('');
      }
      lastAssistantText = '';
    }

    const timelineLines = renderTimeline(
      toolsCtx.currentItems,
      process.stdout.columns || 80,
      getMusicNames(),
      toolsCtx.currentStoryName ?? undefined,
    );
    if (timelineLines.length > 0) {
      for (const line of timelineLines) {
        console.log(line);
      }
      console.log('');
    }
  }

  // Inject context and hint as standalone user messages (no response triggered)
  const userMsg = (text: string) => ({ role: 'user' as const, content: text, timestamp: Date.now() });
  agent.state.messages = [...agent.state.messages, userMsg(contextMessage)];
  if (options.hint) {
    agent.state.messages = [...agent.state.messages, userMsg(`Direction from the user: ${options.hint}`)];
  }

  // Run initial prompt (or skip with --no-intro)
  if (options.intro === false) {
    // Print timeline if available
    const timelineLines = renderTimeline(
      toolsCtx.currentItems,
      process.stdout.columns || 80,
      getMusicNames(),
      toolsCtx.currentStoryName ?? undefined,
    );
    if (timelineLines.length > 0) {
      for (const line of timelineLines) {
        console.log(line);
      }
      console.log('');
    }
  } else {
    agent.state.tools = [];
    const introInstruction = story?.storyline
      ? 'Briefly introduce the current storyline and timeline state, then wait for my direction.'
      : 'Briefly introduce what these source videos contain and wait for my direction before proceeding.';
    await runAgent(introInstruction);
  }
  agent.state.tools = allTools;

  // Slash commands
  const slashCommands: Record<string, { description: string }> = {
    switch: { description: 'switch to another story' },
    export: { description: 'toggle auto export on timeline change' },
    preview: { description: 'toggle background Remotion Studio' },
  };
  const slashCommandActions: Record<string, (storyName: string) => Promise<void>> = {
  };
  const slashCommandNames = Object.keys(slashCommands);

  // Interactive loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => {
      if (slashMode) {
        // Switch argument: complete story names
        if (line === 'switch') {
          return [['switch '], line];
        }
        if (line.startsWith('switch ')) {
          const partial = line.slice('switch '.length).toLowerCase();
          const allStoryNames = db.select({ name: stories.name }).from(stories).all().map((s) => s.name);
          const hits = allStoryNames.filter((n) => n.startsWith(partial)).map((n) => `switch ${n}`);
          return [hits.length ? hits : [], line];
        }
        const partial = line.toLowerCase();
        // Don't return completions if already an exact match
        if (slashCommandNames.includes(partial)) return [[], line];
        const hits = slashCommandNames.filter((c) => c.startsWith(partial));
        return [hits.length ? hits : [], line];
      }
      if (line.startsWith('/')) {
        const partial = line.slice(1).toLowerCase();
        if (partial === 'switch') return [['/switch '], line];
        if (partial.startsWith('switch ')) {
          const storyPartial = partial.slice('switch '.length);
          const allStoryNames = db.select({ name: stories.name }).from(stories).all().map((s) => s.name);
          const hits = allStoryNames.filter((n) => n.startsWith(storyPartial)).map((n) => `/switch ${n}`);
          return [hits.length ? hits : [], line];
        }
        if (slashCommandNames.includes(partial)) return [[], line];
        const hits = slashCommandNames.filter((c) => c.startsWith(partial)).map((c) => `/${c}`);
        return [hits.length ? hits : [], line];
      }
      return [[], line];
    },
  });

  // Switch to slash prompt when '/' is typed at the beginning
  let slashMode = false;
  let hintRowCount = 0;

  function getTerminalRows(text: string): number {
    const cols = process.stdout.columns || 80;
    const width = stringWidth(text);
    return width === 0 ? 0 : Math.ceil(width / cols);
  }

  // Clear the hint area above the input line, leaving cursor at the start of where hints were
  function clearHintArea() {
    if (hintRowCount > 0) {
      process.stdout.write(`\x1b[${hintRowCount}A\r\x1b[0J`);
      hintRowCount = 0;
    }
  }

  // Write hint above input and redraw the input line
  function writeHintAndInput(hint: string, inputText: string) {
    clearHintArea();
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(hint + '\n');
    hintRowCount = getTerminalRows(hint);
    const prompt = slashMode ? chalk.cyan('/ ') : chalk.green('> ');
    process.stdout.write(prompt + inputText);
  }

  function formatSlashHint(filter: string): string {
    return chalk.dim('[tab] to complete: ') + slashCommandNames.map((name) => {
      const matched = !filter || name.startsWith(filter.toLowerCase());
      const label = '/' + name;
      const desc = slashCommands[name].description;
      return matched ? `${chalk.cyan(label)} ${chalk.dim(desc)}` : chalk.dim(`${label} ${desc}`);
    }).join('  ');
  }

  function formatSwitchHint(filter: string): string {
    const allStories = db.select().from(stories).orderBy(desc(stories.updatedAt)).all();
    if (allStories.length === 0) {
      return chalk.dim('enter a name to create a new story');
    }
    return chalk.dim('[tab] ') + allStories.map((s) => {
      const matched = !filter || s.name.startsWith(filter.toLowerCase());
      return matched ? `${chalk.cyan(s.name)} ${chalk.dim(s.title)}` : chalk.dim(`${s.name} ${s.title}`);
    }).join('  ') + chalk.dim(' or enter a new name');
  }

  process.stdin.on('keypress', (_str: string, key: { name?: string }) => {
    // Skip Enter — readline already consumed the line and cleared rl.line to '',
    // which would incorrectly reset slashMode before the main loop checks it.
    if (key && (key.name === 'return' || key.name === 'enter')) return;
    const line = rl.line;
    if (!slashMode && line.startsWith('/')) {
      slashMode = true;
      const rest = line.slice(1);
      writeHintAndInput(formatSlashHint(rest), rest);
      (rl as { line: string }).line = rest;
      (rl as { cursor: number }).cursor = Math.max(0, rl.cursor - 1);
    } else if (slashMode && line === '') {
      slashMode = false;
      clearHintArea();
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(chalk.green('> '));
    } else if (slashMode) {
      const hint = line.startsWith('switch ') ? formatSwitchHint(line.slice('switch '.length)) : formatSlashHint(line);
      writeHintAndInput(hint, line);
    }
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

  let prevTimelineVersion = toolsCtx.timelineVersion;

  try {
    while (true) {
      slashMode = false;
      hintRowCount = 0;
      const userInput = await askQuestion(chalk.green('> '));

      if (userInput === null) {
        // readline closed (ctrl-c, ctrl-d)
        break;
      }
      const trimmed = userInput.trim();
      if (!trimmed) continue;

      // Redraw user input line with background highlight
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
      const cols = process.stdout.columns || 80;
      const promptStr = slashMode ? chalk.cyan('/ ') : chalk.green('> ');
      const displayText = slashMode ? trimmed : trimmed;
      const padRight = Math.max(0, cols - stringWidth('> ' + displayText));
      process.stdout.write(promptStr + chalk.bgHex('#303030')(displayText + ' '.repeat(padRight)) + '\n');

      if (slashMode) {
        const cmd = trimmed.toLowerCase();

        if (cmd === 'switch' || cmd.startsWith('switch ')) {
          const targetName = cmd.slice('switch'.length).trim();
          if (!targetName) {
            console.log(chalk.red('Usage: /switch <story-name>'));
            continue;
          }

          const existingStory = db.select().from(stories).where(eq(stories.name, targetName)).get();

          if (existingStory) {
            toolsCtx.currentStoryId = existingStory.id;
            toolsCtx.currentStoryName = existingStory.name;
            toolsCtx.currentItems = existingStory.timeline ? z.array(TimelineItemSchema).parse(JSON.parse(existingStory.timeline)) : [];
            console.log(chalk.green(`Switched to story: ${existingStory.title} ${chalk.cyan(existingStory.name)}`));
            console.log('');
          } else {
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(targetName)) {
              console.log(chalk.red('Story name must be kebab-case (lowercase letters, numbers, hyphens).'));
              continue;
            }
            toolsCtx.currentStoryId = null;
            toolsCtx.currentStoryName = targetName;
            toolsCtx.currentItems = [];
            console.log(chalk.blue(`Starting new story: ${chalk.cyan(targetName)}`));
            console.log('');
          }

          // Inject context into agent conversation
          const switchContext = renderPrompt('story-switch', {
            name: targetName,
            isUserAction: true,
            isNew: !existingStory,
            storyline: existingStory?.storyline ?? null,
            timelineItems: toolsCtx.currentItems.length > 0 ? JSON.stringify(stripTimelineDefaults(toolsCtx.currentItems), null, 2) : null,
            computedTimeline: toolsCtx.currentItems.length > 0 ? renderPrompt('computed-timeline', buildComputedTimelineData(toolsCtx.currentItems)) : null,
          });
          agent.state.messages = [...agent.state.messages, { role: 'user' as const, content: switchContext, timestamp: Date.now() }];

          // Show timeline if available
          const timelineLines = renderTimeline(
            toolsCtx.currentItems,
            process.stdout.columns || 80,
            getMusicNames(),
            toolsCtx.currentStoryName ?? undefined,
          );
          if (timelineLines.length > 0) {
            for (const line of timelineLines) {
              console.log(line);
            }
            console.log('');
          }

          toolsCtx.timelineVersion++;
        } else if (cmd === 'export') {
          autoExport = !autoExport;
          console.log(chalk.blue(`Auto export: ${autoExport ? 'on' : 'off'}`));
        } else if (cmd === 'preview') {
          autoPreview = !autoPreview;
          if (autoPreview) {
            const storyName = toolsCtx.currentStoryName;
            if (!storyName) {
              console.log(chalk.red('No story yet. Create a storyline first.'));
              autoPreview = false;
              continue;
            }
            const { timelines } = loadExpandedTimelines(db, config, storyName, { quiet: true });
            const publicDir = preparePublicDir(timelines);
            linkedMedia = collectMediaFiles(timelines);
            const remotionProjectDir = fileURLToPath(new URL('../../remotion', import.meta.url));
            previewChild = spawn('npx', ['remotion', 'studio', 'src/index.tsx', `--public-dir=${publicDir}`], {
              cwd: remotionProjectDir,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let urlShown = false;
            const onData = (data: Buffer) => {
              if (urlShown) return;
              const match = data.toString().match(/(https?:\/\/localhost:\d+)/);
              if (match) {
                console.log(chalk.blue(`  Remotion Studio: ${match[1]}`));
                urlShown = true;
              }
            };
            previewChild.stdout?.on('data', onData);
            previewChild.stderr?.on('data', onData);
            previewChild.on('error', (err) => {
              console.log(chalk.red(`  Remotion Studio failed to start: ${err.message}`));
              previewChild = null;
              autoPreview = false;
            });
            previewChild.on('exit', () => {
              if (autoPreview) {
                console.log(chalk.yellow('  Remotion Studio exited — auto preview disabled'));
                autoPreview = false;
              }
              previewChild = null;
            });
            console.log(chalk.blue('Auto preview: on — Remotion Studio starting in background'));
          } else {
            if (previewChild) {
              previewChild.kill();
              previewChild = null;
            }
            console.log(chalk.blue('Auto preview: off'));
          }
        } else {
          const storyName = toolsCtx.currentStoryName;
          if (!storyName) {
            console.log(chalk.red('No story yet. Create a storyline first.'));
            continue;
          }
          const action = slashCommandActions[cmd];
          if (action) {
            await action(storyName);
          } else {
            console.log(chalk.dim(`Unknown command. Available: ${slashCommandNames.map((c) => '/' + c).join(', ')}`));
          }
        }
      } else {
        if (['exit', 'quit', 'q'].includes(trimmed.toLowerCase())) break;

        console.log('');
        spinner.text = 'Thinking...';
        spinner.start();
        await runAgent(trimmed);
      }

      if (toolsCtx.timelineVersion !== prevTimelineVersion) {
        prevTimelineVersion = toolsCtx.timelineVersion;
        const storyName = toolsCtx.currentStoryName;
        if (storyName && (autoExport || autoPreview)) {
          const result = loadExpandedTimelines(db, config, storyName, { quiet: true });
          if (result.errors.length > 0) {
            const targets = [autoPreview && 'Remotion', autoExport && 'FCPXML'].filter(Boolean).join(' and ');
            console.log(chalk.yellow(`${targets} failed: ${result.errors.join('; ')}`));
          } else if (result.timelines.length > 0) {
            const parts: string[] = [];

            if (autoPreview) {
              const currentMedia = collectMediaFiles(result.timelines);
              const hasNewMedia = [...currentMedia].some(f => !linkedMedia.has(f));
              if (hasNewMedia) {
                preparePublicDir(result.timelines);
                linkedMedia = currentMedia;
              } else {
                writeTimelinesJson(result.timelines);
              }
              parts.push('Remotion');
            }

            if (autoExport) {
              exportFcpxmlFiles(result.timelines, db);
              parts.push('FCPXML');
            }

            let msg = parts.join(' and ') + ' updated';
            if (result.correctionCount > 0) {
              msg += ` with ${result.correctionCount} correction${result.correctionCount !== 1 ? 's' : ''}`;
            }
            console.log(chalk.dim(msg));
          } else if (autoPreview) {
            writeTimelinesJson([]);
            linkedMedia = new Set();
          }
        }
      }
    }
  } finally {
    rl.close();
    if (previewChild) {
      autoPreview = false;
      previewChild.kill();
      previewChild = null;
    }
  }

  process.removeListener('unhandledRejection', rejectionHandler);

  console.log(chalk.dim(`Total cost: ${formatCost(totalCost)}`));

  if (toolsCtx.currentStoryId) {
    const finalStory = db.select().from(stories).where(eq(stories.id, toolsCtx.currentStoryId)).get();
    if (finalStory) {
      console.log(chalk.green(`Story saved: ${finalStory.title} ${chalk.cyan(finalStory.name)}`));
      if (finalStory.timeline) {
        const cmd = chalk.bold.green;
        console.log(chalk.green(`You can ${cmd('montai preview')}, ${cmd('montai export')}, or ${cmd(`montai render ${finalStory.name}`)}.`));
      }
    }
  }
}
