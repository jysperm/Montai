import chalk from 'chalk';
import ora from 'ora';
import { spawn, type ChildProcess } from 'child_process';
import { parse } from 'path';
import { fileURLToPath } from 'url';
import { eq, desc, and } from 'drizzle-orm';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, type AssistantMessage, type Message } from '@mariozechner/pi-ai';
import type { MontaiDb } from '../db/index.js';
import { stories, sessions, sessionMessages, storyMarks } from '../db/schema.js';
import { loadResolvedTimelines } from '../utils/project.js';
import { renderPrompt } from '../prompts/index.js';
import { TimelineItemSchema, type TimelineItem } from '../schemas/timeline.js';
import { buildComputedTimelineData } from '../schemas/timeline/compute.js';
import { stripTimelineDefaults } from '../schemas/timeline/edit.js';
import { z } from 'zod';
import { extractFileContentFromToolResults, limitVideoFilesInContext, removeExpiredFileRefs } from './agent-context.js';
import { formatCost } from '../analyzer/utils.js';
import { logRequest, logStep, logResponse, logToolCall } from '../utils/llm-logging.js';
import { ApiDebugCapture } from '../utils/api-debug.js';
import { getStoryTools, type StoryToolsContext } from './story-tools.js';
import { formatGeneratedMusicPrompt, renderTimeline } from '../utils/render-timeline.js';
import { exportFcpxmlFiles } from '../commands/export.js';
import { preparePublicDir, collectMediaFiles, writeTimelinesJson } from '../remotion/public-dir.js';
import { StoryInput, formatUserInput, formatAssistantText, printToolCall, selectMarkInteractive } from './story-ui.js';
import type { ProjectConfig } from '../schemas/project.js';
import { resolveResolution, sequenceShape } from '../schemas/project.js';
import type { FeatureFlags } from '../feature-flags.js';

type StoryRow = typeof stories.$inferSelect;

const AUTO_BACKUP_MARK_NAME = 'last-overwritten';
const INTRO_EXISTING_STORY_INSTRUCTION = 'Briefly introduce the current storyline and timeline state, then wait for my direction.';
const INTRO_NEW_STORY_INSTRUCTION = 'Briefly introduce what these source videos contain and wait for my direction before proceeding.';

function getUserMessageText(message: Message): string | null {
  if (message.role !== 'user') return null;
  if (typeof message.content === 'string') return message.content;

  const text = message.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('');

  return text || null;
}

function isStoryIntroInstruction(text: string | null): boolean {
  return text === INTRO_EXISTING_STORY_INSTRUCTION || text === INTRO_NEW_STORY_INSTRUCTION;
}

export interface StoryAgentOptions {
  db: MontaiDb;
  config: ProjectConfig;
  features: FeatureFlags;
  agentInstructions: string | null;
  story: StoryRow | undefined;
  toolsCtx: StoryToolsContext;
  hint?: string;
  intro?: boolean;
  isResuming: boolean;
  resumedMessages: Message[];
  resumedSessionId: number | null;
}

// TUI output convention: each output block adds its own trailing blank line
// (console.log('')) for spacing. The prompt uses '> ' without a leading '\n',
// relying on the previous block's trailing blank line for separation.
// Use console.log for all visible content (ensures trailing '\n'); reserve
// process.stdout.write for cursor/ANSI control only. If a write lacks a
// trailing '\n', readline will erase it when drawing the next prompt.
export class StoryAgent {
  private db: MontaiDb;
  private config: ProjectConfig;
  private features: FeatureFlags;
  private agentInstructions: string | null;
  private toolsCtx: StoryToolsContext;
  private hint?: string;
  private introEnabled: boolean;
  private isResuming: boolean;
  private resumedMessages: Message[];

  private agent!: Agent;
  private spinner = ora({ text: 'Thinking...', discardStdin: false });
  private apiDebug = new ApiDebugCapture();

  private totalCost = 0;
  private autoExport = false;
  private autoPreview = false;
  private previewChild: ChildProcess | null = null;
  private linkedMedia = new Set<string>();

  private lastAssistantText = '';
  private toolArgsMap = new Map<string, Record<string, unknown>>();
  private hadToolOutput = false;
  private debugStep = 0;
  private debugTurnStartTime = 0;

  private currentSessionId!: number;
  private dbMessageCount = 0;

  private allTools!: ReturnType<typeof getStoryTools>['tools'];
  private resetWatchCount!: ReturnType<typeof getStoryTools>['resetWatchCount'];

  private prevTimelineVersion = 0;

  private slashCommands: Record<string, { description: string }> = {
    switch: { description: 'to another story' },
    mark: { description: 'current timeline as checkpoint' },
    marks: { description: 'restore from marks' },
    export: { description: 'toggle .fcpxml auto-export' },
    preview: { description: 'start Remotion Studio' },
  };
  private slashCommandNames = Object.keys(this.slashCommands);
  private storyInput!: StoryInput;

  constructor(opts: StoryAgentOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.features = opts.features;
    this.agentInstructions = opts.agentInstructions;
    this.toolsCtx = opts.toolsCtx;
    this.storyInput = new StoryInput({ db: this.db, slashCommands: this.slashCommands });
    this.hint = opts.hint;
    this.introEnabled = opts.intro !== false;
    this.isResuming = opts.isResuming;
    this.resumedMessages = opts.resumedMessages;

    if (opts.isResuming) {
      this.currentSessionId = opts.resumedSessionId!;
      this.dbMessageCount = opts.resumedMessages.length;
    } else {
      const sessionRow = this.db.insert(sessions)
        .values({ currentStoryId: opts.story?.id ?? null })
        .returning()
        .get();
      this.currentSessionId = sessionRow.id;
    }
    this.toolsCtx.sessionId = this.currentSessionId;

    const { tools, resetWatchCount } = getStoryTools(this.toolsCtx);
    this.allTools = tools;
    this.resetWatchCount = resetWatchCount;
  }

  private getMusicNames() {
    return new Map(this.toolsCtx.allMusic.map((m) => [
      m.id,
      m.type === 'generated'
        ? formatGeneratedMusicPrompt(m.generationPrompt ?? '')
        : parse(m.filename).name,
    ]));
  }

  private setupAgent() {
    const model = getModel('google', this.config.models.editing as Parameters<typeof getModel>[1]);

    this.agent = new Agent({
      initialState: {
        systemPrompt: renderPrompt('story-system', {
          language: this.config.language,
          overlayLanguages: this.config.effects.languages,
          agentInstructions: this.agentInstructions ?? null,
          features: this.features,
          ...(() => {
            const { width, height } = resolveResolution(this.config.output.resolution);
            const shape = sequenceShape(width, height);
            return { outputShape: shape, isLandscape: shape === 'landscape' };
          })(),
        }),
        model,
      },
      getApiKey: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      transformContext: async (messages) => limitVideoFilesInContext(extractFileContentFromToolResults(removeExpiredFileRefs(messages))),
      streamFn: this.apiDebug.streamFn,
    });

    this.agent.state.tools = this.allTools;
    this.toolsCtx.agent = this.agent;

    this.agent.subscribe((event) => {
      try {
        this.handleAgentEvent(event);
      } catch (err) {
        this.spinner.stop();
        console.log(chalk.red(`  Subscriber error: ${err}`));
      }
    });
  }

  private handleAgentEvent(event: Parameters<Parameters<Agent['subscribe']>[0]>[0]) {
    switch (event.type) {
      case 'turn_start':
        this.debugStep++;
        this.debugTurnStartTime = Date.now();
        logRequest(
          this.agent.state.messages as Message[],
          this.agent.state.systemPrompt,
        );
        this.spinner.stop();
        this.resetWatchCount();
        this.spinner.text = 'Thinking...';
        this.spinner.start();
        break;
      case 'message_end': {
        const msg = event.message;
        if (msg && msg.role === 'assistant' && 'usage' in msg) {
          const assistantMsg = msg as AssistantMessage;
          logStep({
            step: this.debugStep,
            model: assistantMsg.model,
            usage: assistantMsg.usage,
            durationMs: Date.now() - this.debugTurnStartTime,
          });
          logResponse(assistantMsg);
        }
        break;
      }
      case 'tool_execution_start':
        this.toolArgsMap.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
        this.spinner.text = `${event.toolName}...`;
        break;
      case 'tool_execution_end': {
        this.spinner.stop();
        const toolArgs = this.toolArgsMap.get(event.toolCallId) ?? {};
        this.toolArgsMap.delete(event.toolCallId);
        logToolCall(event.toolName, toolArgs, event.result);

        if (event.isError) {
          const errorContent = (event.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
          const flattened = errorContent?.replace(/\s+/g, ' ').trim();
          const errorSummary = flattened
            ? (flattened.length > 200 ? flattened.slice(0, 200) + '...' : flattened)
            : 'failed';
          this.hadToolOutput = true;
          printToolCall(event.toolName, toolArgs, errorSummary);
          this.spinner.text = 'Thinking...';
          this.spinner.start();
          break;
        }

        this.hadToolOutput = true;
        printToolCall(event.toolName, toolArgs);

        if (event.toolName === 'generateMusic') {
          const resultText = (event.result as { content: { text: string }[] })?.content?.[0]?.text ?? '';
          const idMatch = resultText.match(/Music ID: (\d+)/);
          if (idMatch) {
            console.log(chalk.dim(`    → musicId ${idMatch[1]}`));
          }
        }

        this.spinner.text = 'Thinking...';
        this.spinner.start();
        break;
      }
      case 'turn_end': {
        this.spinner.stop();
        const msg = event.message;
        if (msg && 'usage' in msg) {
          const assistantMsg = msg as AssistantMessage;
          this.totalCost += assistantMsg.usage.cost.total;
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
            const dumpPath = this.apiDebug.dumpError(assistantMsg);
            if (dumpPath) {
              console.log(chalk.dim(`  Debug dump written to ${dumpPath}`));
            }
          }
        }
        if (msg && 'content' in msg && Array.isArray(msg.content)) {
          const text = (msg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
          if (text) {
            this.lastAssistantText = text;
          }
        }

        const currentMessages = this.agent.state.messages;
        if (currentMessages.length > this.dbMessageCount) {
          const newMessages = currentMessages.slice(this.dbMessageCount);
          for (const m of newMessages) {
            this.db.insert(sessionMessages)
              .values({ sessionId: this.currentSessionId, content: JSON.stringify(m) })
              .run();
          }
          this.db.update(sessions)
            .set({ currentStoryId: this.toolsCtx.currentStoryId })
            .where(eq(sessions.id, this.currentSessionId))
            .run();
          this.dbMessageCount = currentMessages.length;
        }
        break;
      }
      case 'agent_end':
        break;
    }
  }

  private async runAgent(message: string): Promise<void> {
    this.hadToolOutput = false;
    try {
      await this.agent.prompt(message);
      await this.agent.waitForIdle();
    } catch (err) {
      this.spinner.stop();
      console.log('');
      console.log(chalk.red(`  Agent error: ${err}`));
      console.log(chalk.dim('  You can retry or give different instructions.'));
      console.log('');
    }
    this.spinner.stop();

    if (this.lastAssistantText) {
      if (this.hadToolOutput) {
        console.log('');
      }
      const formatted = formatAssistantText(this.lastAssistantText);
      console.log(formatted);
      if (!formatted.endsWith('\n')) {
        console.log('');
      }
      this.lastAssistantText = '';
    }

    this.printTimeline();
  }

  private printTimeline() {
    const timelineLines = renderTimeline(
      this.toolsCtx.currentItems,
      process.stdout.columns || 80,
      this.getMusicNames(),
      this.toolsCtx.currentStoryName ?? undefined,
    );
    if (timelineLines.length > 0) {
      for (const line of timelineLines) {
        console.log(line);
      }
      console.log('');
    }
  }

  private buildContextMessage(videoAnalysisData: unknown[], summaryVideoAnalyses: unknown[], musicAnalysisData: unknown[], summaryMusicAnalyses: unknown[], voiceoverAnalysisData: unknown[], summaryVoiceoverAnalyses: unknown[], generatedMusicData: unknown[], storyline: string | null) {
    const currentStory = this.toolsCtx.currentStoryId
      ? this.db.select({ name: stories.name, title: stories.title }).from(stories).where(eq(stories.id, this.toolsCtx.currentStoryId)).get()
      : null;
    return renderPrompt('story-context', {
      fullVideoAnalyses: (videoAnalysisData as unknown[]).length > 0 ? videoAnalysisData : null,
      summaryVideoAnalyses: (summaryVideoAnalyses as unknown[]).length > 0 ? summaryVideoAnalyses : null,
      currentStoryName: currentStory?.name ?? this.toolsCtx.currentStoryName,
      currentStoryTitle: currentStory?.title ?? null,
      storyline,
      timelineItems: this.toolsCtx.currentItems.length > 0 ? JSON.stringify(stripTimelineDefaults(this.toolsCtx.currentItems), null, 2) : null,
      computedTimeline: this.toolsCtx.currentItems.length > 0 ? renderPrompt('computed-timeline', buildComputedTimelineData(this.toolsCtx.currentItems)) : null,
      fullVoiceoverAnalyses: this.features.voiceover && (voiceoverAnalysisData as unknown[]).length > 0 ? voiceoverAnalysisData : null,
      summaryVoiceoverAnalyses: this.features.voiceover && (summaryVoiceoverAnalyses as unknown[]).length > 0 ? summaryVoiceoverAnalyses : null,
      fullMusicAnalyses: this.features.music && (musicAnalysisData as unknown[]).length > 0 ? musicAnalysisData : null,
      summaryMusicAnalyses: this.features.music && (summaryMusicAnalyses as unknown[]).length > 0 ? summaryMusicAnalyses : null,
      generatedMusic: this.features.musicGeneration && (generatedMusicData as unknown[]).length > 0 ? generatedMusicData : null,
    });
  }

  private replayResumedMessages() {
    let replayStart = 0;
    if (this.resumedMessages.length > 0 && (this.resumedMessages[0] as Message).role === 'user') {
      replayStart = 1;
      if (replayStart < this.resumedMessages.length) {
        const next = this.resumedMessages[replayStart] as Message;
        const text = getUserMessageText(next);
        if (text?.startsWith('Direction from the user: ')) {
          replayStart++;
        }
      }
      if (replayStart < this.resumedMessages.length) {
        const next = this.resumedMessages[replayStart] as Message;
        if (isStoryIntroInstruction(getUserMessageText(next))) {
          replayStart++;
        }
      }
    }
    const toolResultsById = new Map<string, { isError: boolean; content: Array<{ type: string; text?: string }> }>();
    for (const m of this.resumedMessages as Message[]) {
      if (m.role === 'toolResult') {
        toolResultsById.set(m.toolCallId, {
          isError: m.isError,
          content: (Array.isArray(m.content) ? m.content : []) as Array<{ type: string; text?: string }>,
        });
      }
    }
    let hadReplayToolOutput = false;
    for (let i = replayStart; i < this.resumedMessages.length; i++) {
      const m = this.resumedMessages[i] as Message;
      if (m.role === 'user') {
        hadReplayToolOutput = false;
        const text = getUserMessageText(m);
        if (text) {
          console.log(formatUserInput(text));
          console.log('');
        }
      } else if (m.role === 'assistant') {
        const content = Array.isArray(m.content) ? m.content as Array<{ type: string; id?: string; text?: string; name?: string; arguments?: Record<string, unknown> }> : [];
        const toolCalls = content.filter((c) => c.type === 'toolCall');
        for (const tc of toolCalls) {
          const tcArgs = tc.arguments ?? {};
          const result = tc.id ? toolResultsById.get(tc.id) : undefined;
          let errorSummary: string | undefined;
          if (result?.isError) {
            const errorContent = result.content?.[0]?.text;
            const flattened = errorContent?.replace(/\s+/g, ' ').trim();
            errorSummary = flattened
              ? (flattened.length > 200 ? flattened.slice(0, 200) + '...' : flattened)
              : 'failed';
          }
          printToolCall(tc.name ?? 'tool', tcArgs, errorSummary);
        }
        if (toolCalls.length > 0) hadReplayToolOutput = true;
        const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
        if (hadReplayToolOutput && text) console.log('');
        if (text) {
          hadReplayToolOutput = false;
          const formatted = formatAssistantText(text);
          console.log(formatted);
          if (!formatted.endsWith('\n')) console.log('');
        }
      }
    }
  }

  private async handleSlashSwitch(targetName: string) {
    if (!targetName) {
      console.log(chalk.red('Usage: /switch <story-name>'));
      return;
    }

    const existingStory = this.db.select().from(stories).where(eq(stories.name, targetName)).get();

    if (existingStory) {
      this.toolsCtx.currentStoryId = existingStory.id;
      this.toolsCtx.currentStoryName = existingStory.name;
      this.toolsCtx.currentItems = existingStory.timeline ? z.array(TimelineItemSchema).parse(JSON.parse(existingStory.timeline)) : [];
      console.log(chalk.green(`Switched to story: ${existingStory.title} ${chalk.cyan(existingStory.name)}`));
      console.log('');
    } else {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(targetName)) {
        console.log(chalk.red('Story name must be kebab-case (lowercase letters, numbers, hyphens).'));
        return;
      }
      this.toolsCtx.currentStoryId = null;
      this.toolsCtx.currentStoryName = targetName;
      this.toolsCtx.currentItems = [];
      console.log(chalk.blue(`Starting new story: ${chalk.cyan(targetName)}`));
      console.log('');
    }

    const switchContext = renderPrompt('story-switch', {
      name: targetName,
      currentStoryName: existingStory?.name ?? targetName,
      currentStoryTitle: existingStory?.title ?? null,
      isUserAction: true,
      isNew: !existingStory,
      storyline: existingStory?.storyline ?? null,
      timelineItems: this.toolsCtx.currentItems.length > 0 ? JSON.stringify(stripTimelineDefaults(this.toolsCtx.currentItems), null, 2) : null,
      computedTimeline: this.toolsCtx.currentItems.length > 0 ? renderPrompt('computed-timeline', buildComputedTimelineData(this.toolsCtx.currentItems)) : null,
    });
    this.agent.state.messages = [...this.agent.state.messages, { role: 'user' as const, content: switchContext, timestamp: Date.now() }];

    const switchMessages = this.agent.state.messages.slice(this.dbMessageCount);
    for (const m of switchMessages) {
      this.db.insert(sessionMessages)
        .values({ sessionId: this.currentSessionId, content: JSON.stringify(m) })
        .run();
    }
    this.db.update(sessions)
      .set({ currentStoryId: this.toolsCtx.currentStoryId })
      .where(eq(sessions.id, this.currentSessionId))
      .run();
    this.dbMessageCount = this.agent.state.messages.length;

    this.printTimeline();
    this.toolsCtx.timelineVersion++;
  }

  private generateMarkTimestamp(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  private handleSlashMark(name: string) {
    if (!this.toolsCtx.currentStoryId) {
      console.log(chalk.red('No active story to mark. Create a storyline first.'));
      return;
    }
    if (this.toolsCtx.currentItems.length === 0) {
      console.log(chalk.red('Current timeline is empty — nothing to mark.'));
      return;
    }

    const markName = name || this.generateMarkTimestamp();
    if (name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      console.log(chalk.red('Mark name must be kebab-case (lowercase letters, numbers, hyphens).'));
      return;
    }
    if (markName === AUTO_BACKUP_MARK_NAME) {
      console.log(chalk.red(`"${AUTO_BACKUP_MARK_NAME}" is reserved for the auto-backup created on /marks restore.`));
      return;
    }

    const existing = this.db.select().from(storyMarks)
      .where(and(eq(storyMarks.storyId, this.toolsCtx.currentStoryId), eq(storyMarks.name, markName)))
      .get();
    if (existing) {
      console.log(chalk.red(`A mark named "${markName}" already exists for this story.`));
      return;
    }

    const timelineJson = JSON.stringify(stripTimelineDefaults(this.toolsCtx.currentItems));
    this.db.insert(storyMarks).values({
      storyId: this.toolsCtx.currentStoryId,
      name: markName,
      timeline: timelineJson,
      createdAt: new Date().toISOString(),
    }).run();

    console.log(chalk.green(`Marked timeline: ${chalk.cyan(markName)}`));
    console.log('');
  }

  private async handleSlashMarks() {
    if (!this.toolsCtx.currentStoryId) {
      console.log(chalk.red('No active story. Create a storyline first.'));
      return;
    }

    const marks = this.db.select().from(storyMarks)
      .where(eq(storyMarks.storyId, this.toolsCtx.currentStoryId))
      .orderBy(desc(storyMarks.createdAt))
      .all();

    if (marks.length === 0) {
      console.log(chalk.dim('No marks for this story yet. Use /mark to create one.'));
      console.log('');
      return;
    }

    const selected = await selectMarkInteractive(marks, this.db);
    if (!selected) {
      return;
    }

    await this.restoreMark(selected);
  }

  private async restoreMark(mark: typeof storyMarks.$inferSelect) {
    if (!this.toolsCtx.currentStoryId) return;

    let restoredItems: TimelineItem[];
    try {
      restoredItems = z.array(TimelineItemSchema).parse(JSON.parse(mark.timeline));
    } catch (err) {
      console.log(chalk.red(`Failed to parse mark timeline: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // Auto-backup the about-to-be-overwritten timeline to a fixed-name mark
    // so the user can recover from an accidental restore. Reuses the same slot.
    const backedUp = this.toolsCtx.currentItems.length > 0;
    if (backedUp) {
      this.db.delete(storyMarks)
        .where(and(eq(storyMarks.storyId, this.toolsCtx.currentStoryId), eq(storyMarks.name, AUTO_BACKUP_MARK_NAME)))
        .run();
      this.db.insert(storyMarks).values({
        storyId: this.toolsCtx.currentStoryId,
        name: AUTO_BACKUP_MARK_NAME,
        timeline: JSON.stringify(stripTimelineDefaults(this.toolsCtx.currentItems)),
        createdAt: new Date().toISOString(),
      }).run();
    }

    const now = new Date().toISOString();
    this.db.update(stories)
      .set({
        timeline: JSON.stringify(stripTimelineDefaults(restoredItems)),
        updatedAt: now,
      })
      .where(eq(stories.id, this.toolsCtx.currentStoryId))
      .run();

    this.toolsCtx.currentItems = restoredItems;
    this.toolsCtx.timelineVersion++;

    console.log(chalk.green(`Restored timeline mark: ${chalk.cyan(mark.name)}`));
    if (backedUp) {
      console.log(chalk.dim(`Previous timeline saved as ${chalk.cyan(AUTO_BACKUP_MARK_NAME)}`));
    }
    console.log('');
    this.printTimeline();

    const restoreContext = renderPrompt('story-mark-restore', {
      timelineItems: JSON.stringify(stripTimelineDefaults(restoredItems), null, 2),
      computedTimeline: renderPrompt('computed-timeline', buildComputedTimelineData(restoredItems)),
    });
    this.agent.state.messages = [...this.agent.state.messages, { role: 'user' as const, content: restoreContext, timestamp: Date.now() }];

    const newMessages = this.agent.state.messages.slice(this.dbMessageCount);
    for (const m of newMessages) {
      this.db.insert(sessionMessages)
        .values({ sessionId: this.currentSessionId, content: JSON.stringify(m) })
        .run();
    }
    this.db.update(sessions)
      .set({ currentStoryId: this.toolsCtx.currentStoryId })
      .where(eq(sessions.id, this.currentSessionId))
      .run();
    this.dbMessageCount = this.agent.state.messages.length;
  }

  private handleSlashExport() {
    this.autoExport = !this.autoExport;
    console.log(chalk.blue(`Auto export: ${this.autoExport ? 'on' : 'off'}`));
    if (this.autoExport) {
      const storyName = this.toolsCtx.currentStoryName;
      if (storyName) {
        const result = loadResolvedTimelines(this.db, this.config, storyName, { quiet: true });
        if (result.errors.length > 0) {
          console.log(chalk.yellow(`FCPXML failed: ${result.errors.join('; ')}`));
        } else if (result.timelines.length > 0) {
          exportFcpxmlFiles(result.timelines, this.db);
          let msg = 'FCPXML exported';
          if (result.correctionCount > 0) {
            msg += ` with ${result.correctionCount} correction${result.correctionCount !== 1 ? 's' : ''}`;
          }
          console.log(chalk.dim(msg));
        }
      }
    }
  }

  private handleSlashPreview() {
    this.autoPreview = !this.autoPreview;
    if (this.autoPreview) {
      const storyName = this.toolsCtx.currentStoryName;
      if (!storyName) {
        console.log(chalk.red('No story yet. Create a storyline first.'));
        this.autoPreview = false;
        return;
      }
      const { timelines } = loadResolvedTimelines(this.db, this.config, storyName, { quiet: true });
      let publicDir: string;
      try {
        publicDir = preparePublicDir(timelines);
      } catch (err) {
        console.log(chalk.red(err instanceof Error ? err.message : String(err)));
        console.log(`The stored timeline may contain outdated paths. Try re-running ${chalk.bold('montai story')} to regenerate the timeline.`);
        this.autoPreview = false;
        return;
      }
      this.linkedMedia = collectMediaFiles(timelines);
      const remotionProjectDir = fileURLToPath(new URL('../../remotion', import.meta.url));
      this.previewChild = spawn('npx', ['remotion', 'studio', 'src/index.tsx', `--public-dir=${publicDir}`], {
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
      this.previewChild.stdout?.on('data', onData);
      this.previewChild.stderr?.on('data', onData);
      this.previewChild.on('error', (err) => {
        console.log(chalk.red(`  Remotion Studio failed to start: ${err.message}`));
        this.previewChild = null;
        this.autoPreview = false;
      });
      this.previewChild.on('exit', () => {
        if (this.autoPreview) {
          console.log(chalk.yellow('  Remotion Studio exited — auto preview disabled'));
          this.autoPreview = false;
        }
        this.previewChild = null;
      });
      console.log(chalk.blue('Auto preview: on — Remotion Studio starting in background'));
    } else {
      if (this.previewChild) {
        this.previewChild.kill();
        this.previewChild = null;
      }
      console.log(chalk.blue('Auto preview: off'));
    }
  }

  private async handleSlashCommand(cmd: string): Promise<boolean> {
    if (cmd === 'switch' || cmd.startsWith('switch ')) {
      const targetName = cmd.slice('switch'.length).trim();
      await this.handleSlashSwitch(targetName);
      return true;
    } else if (cmd === 'mark' || cmd.startsWith('mark ')) {
      const name = cmd.slice('mark'.length).trim();
      this.handleSlashMark(name);
      return true;
    } else if (cmd === 'marks') {
      await this.handleSlashMarks();
      return true;
    } else if (cmd === 'export') {
      this.handleSlashExport();
      return true;
    } else if (cmd === 'preview') {
      this.handleSlashPreview();
      return true;
    }

    const storyName = this.toolsCtx.currentStoryName;
    if (!storyName) {
      console.log(chalk.red('No story yet. Create a storyline first.'));
      return true;
    }

    console.log(chalk.dim(`Unknown command. Available: ${this.slashCommandNames.map((c) => '/' + c).join(', ')}`));
    return true;
  }

  private syncAutoExportPreview() {
    if (this.toolsCtx.timelineVersion === this.prevTimelineVersion) return;
    this.prevTimelineVersion = this.toolsCtx.timelineVersion;

    const storyName = this.toolsCtx.currentStoryName;
    if (!storyName || (!this.autoExport && !this.autoPreview)) return;

    const result = loadResolvedTimelines(this.db, this.config, storyName, { quiet: true });
    if (result.errors.length > 0) {
      const targets = [this.autoPreview && 'Remotion', this.autoExport && 'FCPXML'].filter(Boolean).join(' and ');
      console.log(chalk.yellow(`${targets} failed: ${result.errors.join('; ')}`));
    } else if (result.timelines.length > 0) {
      const parts: string[] = [];

      if (this.autoPreview) {
        const currentMedia = collectMediaFiles(result.timelines);
        const hasNewMedia = [...currentMedia].some(f => !this.linkedMedia.has(f));
        try {
          if (hasNewMedia) {
            preparePublicDir(result.timelines);
            this.linkedMedia = currentMedia;
          } else {
            writeTimelinesJson(result.timelines);
          }
          parts.push('Remotion');
        } catch (err) {
          console.log(chalk.yellow(`Remotion failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      if (this.autoExport) {
        exportFcpxmlFiles(result.timelines, this.db);
        parts.push('FCPXML');
      }

      if (parts.length > 0) {
        let msg = parts.join(' and ') + ' updated';
        if (result.correctionCount > 0) {
          msg += ` with ${result.correctionCount} correction${result.correctionCount !== 1 ? 's' : ''}`;
        }
        console.log(chalk.dim(msg));
      }
    } else if (this.autoPreview) {
      writeTimelinesJson([]);
      this.linkedMedia = new Set();
    }
  }

  private async startInteractiveLoop(): Promise<void> {
    try {
      while (true) {
        const userInput = await this.storyInput.read();

        if (userInput === null) break;
        const text = userInput.text;
        const trimmed = text.trim();
        if (!trimmed) continue;

        const submittedText = userInput.slashMode ? trimmed : text;
        process.stdout.write(formatUserInput(submittedText, userInput.slashMode) + '\n');
        this.storyInput.remember(submittedText, userInput.slashMode);

        if (userInput.slashMode) {
          const cmd = trimmed.toLowerCase();
          await this.handleSlashCommand(cmd);
        } else {
          if (['exit', 'quit', 'q'].includes(trimmed.toLowerCase())) break;

          console.log('');
          this.spinner.text = 'Thinking...';
          this.spinner.start();
          await this.runAgent(text);
        }

        this.syncAutoExportPreview();
      }
    } finally {
      if (this.previewChild) {
        this.autoPreview = false;
        this.previewChild.kill();
        this.previewChild = null;
      }
    }
  }

  async run(contextData: {
    videoAnalysisData: unknown[];
    musicAnalysisData: unknown[];
    voiceoverAnalysisData: unknown[];
    generatedMusicData: unknown[];
    storyline: string | null;
  }) {
    this.setupAgent();

    const rejectionHandler = (reason: unknown) => {
      this.spinner.stop();
      console.log(chalk.red(`  Unhandled rejection: ${reason}`));
      console.log(chalk.dim('  You can retry or give different instructions.'));
    };
    process.on('unhandledRejection', rejectionHandler);

    // Split analyses into full (referenced in timeline) and summary (unreferenced)
    const hasTimeline = this.toolsCtx.currentItems.length > 0;
    let fullVideoAnalyses = contextData.videoAnalysisData;
    let summaryVideoAnalyses: unknown[] = [];
    let fullMusicAnalyses = contextData.musicAnalysisData;
    let summaryMusicAnalyses: unknown[] = [];
    let fullVoiceoverAnalyses = contextData.voiceoverAnalysisData;
    let summaryVoiceoverAnalyses: unknown[] = [];

    if (hasTimeline) {
      const referencedVideoIds = new Set(
        this.toolsCtx.currentItems.filter((i) => i.type === 'clip').map((i) => (i as { videoId: number }).videoId),
      );
      fullVideoAnalyses = (contextData.videoAnalysisData as Array<{ videoId: number }>).filter((v) => referencedVideoIds.has(v.videoId));
      summaryVideoAnalyses = (contextData.videoAnalysisData as Array<{ videoId: number }>).filter((v) => !referencedVideoIds.has(v.videoId));

      const hasMusicItems = this.toolsCtx.currentItems.some((i) => i.type === 'music');
      if (hasMusicItems) {
        const referencedMusicIds = new Set(
          this.toolsCtx.currentItems.filter((i) => i.type === 'music').map((i) => (i as { musicId?: number }).musicId).filter((id): id is number => id != null),
        );
        fullMusicAnalyses = (contextData.musicAnalysisData as Array<{ musicId: number }>).filter((m) => referencedMusicIds.has(m.musicId));
        summaryMusicAnalyses = (contextData.musicAnalysisData as Array<{ musicId: number }>).filter((m) => !referencedMusicIds.has(m.musicId));
      }

      const hasVoiceoverItems = this.toolsCtx.currentItems.some((i) => i.type === 'voiceover');
      if (hasVoiceoverItems) {
        const referencedVoiceoverIds = new Set(
          this.toolsCtx.currentItems.filter((i) => i.type === 'voiceover').map((i) => (i as { voiceoverId?: number }).voiceoverId).filter((id): id is number => id != null),
        );
        fullVoiceoverAnalyses = (contextData.voiceoverAnalysisData as Array<{ voiceoverId: number }>).filter((v) => referencedVoiceoverIds.has(v.voiceoverId));
        summaryVoiceoverAnalyses = (contextData.voiceoverAnalysisData as Array<{ voiceoverId: number }>).filter((v) => !referencedVoiceoverIds.has(v.voiceoverId));
      }
    }

    const contextMessage = this.buildContextMessage(
      fullVideoAnalyses, summaryVideoAnalyses,
      fullMusicAnalyses, summaryMusicAnalyses,
      fullVoiceoverAnalyses, summaryVoiceoverAnalyses,
      contextData.generatedMusicData,
      contextData.storyline,
    );

    const userMsg = (text: string) => ({ role: 'user' as const, content: text, timestamp: Date.now() });

    if (this.isResuming) {
      this.agent.state.messages = this.resumedMessages;
      this.replayResumedMessages();
      this.printTimeline();
    } else {
      this.agent.state.messages = [...this.agent.state.messages, userMsg(contextMessage)];
      if (this.hint) {
        this.agent.state.messages = [...this.agent.state.messages, userMsg(`Direction from the user: ${this.hint}`)];
      }
    }

    if (!this.isResuming && !this.introEnabled) {
      this.printTimeline();
    } else if (!this.isResuming) {
      this.agent.state.tools = [];
      if (this.introEnabled) {
        this.spinner.start();
      }
      const introInstruction = contextData.storyline
        ? INTRO_EXISTING_STORY_INSTRUCTION
        : INTRO_NEW_STORY_INSTRUCTION;
      await this.runAgent(introInstruction);
    }
    this.agent.state.tools = this.allTools;

    await this.startInteractiveLoop();

    process.removeListener('unhandledRejection', rejectionHandler);

    console.log('');
    console.log(chalk.dim(`Total cost: ${formatCost(this.totalCost)}`));

    if (this.toolsCtx.currentStoryId) {
      const finalStory = this.db.select().from(stories).where(eq(stories.id, this.toolsCtx.currentStoryId)).get();
      if (finalStory) {
        console.log(chalk.dim(`Story saved: ${finalStory.title} ${finalStory.name}`));
      }
    }
    if (this.dbMessageCount > 0) {
      console.log(chalk.dim(`Run ${chalk.bold(`montai story --resume ${this.currentSessionId}`)} to continue this session.`));
    }
  }
}
