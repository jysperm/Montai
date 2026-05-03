import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { eq, desc, count, sql } from 'drizzle-orm';
import { initDb } from '../db/index.js';
import { videos, videoAnalyses, stories, music, musicAnalyses, voiceovers, voiceoverAnalyses, sessions, sessionMessages } from '../db/schema.js';
import { loadProjectConfig, readProjectFile } from '../utils/project.js';
import { languageNames } from '../prompts/index.js';
import { TimelineItemSchema, type TimelineItem } from '../schemas/timeline-items.js';
import { z } from 'zod';
import { formatTimeAgo, formatStoryLine } from '../utils/format.js';
import { resolveFeatureFlags } from '../feature-flags.js';
import { selectStoryInteractive } from '../agents/story-ui.js';
import { StoryAgent } from '../agents/story-agent.js';
import type { Message } from '@mariozechner/pi-ai';

export async function storyCommand(
  name?: string,
  options: { new?: boolean; list?: boolean; hint?: string; intro?: boolean; resume?: boolean | string; sessions?: boolean } = {},
) {
  const config = loadProjectConfig();
  const db = await initDb();
  const agentInstructions = readProjectFile('AGENTS.md');

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

  // --sessions: list historical sessions and exit
  if (options.sessions) {
    const allSessions = db.select().from(sessions).orderBy(desc(sessions.id)).all();

    if (allSessions.length === 0) {
      console.log(chalk.dim('No sessions found.'));
    } else {
      let hasOutput = false;
      for (const s of allSessions) {
        const msgs = db.select({
          messageCount: count(),
          startedAt: sql<number>`MIN(json_extract(${sessionMessages.content}, '$.timestamp'))`,
          lastActivity: sql<number>`MAX(json_extract(${sessionMessages.content}, '$.timestamp'))`,
        }).from(sessionMessages).where(eq(sessionMessages.sessionId, s.id)).get()!;

        if (msgs.messageCount === 0) continue;

        const storyRow = s.currentStoryId
          ? db.select().from(stories).where(eq(stories.id, s.currentStoryId)).get()
          : null;
        const storyLabel = storyRow ? `${chalk.cyan(storyRow.name)}  ${storyRow.title}` : chalk.dim('no story');
        const startStr = msgs.startedAt ? formatTimeAgo(new Date(msgs.startedAt).toISOString()) : '?';
        const endStr = msgs.lastActivity ? formatTimeAgo(new Date(msgs.lastActivity).toISOString()) : '?';
        const timeStr = startStr === endStr ? startStr : `${startStr} – ${endStr}`;
        console.log(`  ${chalk.dim(`#${s.id}`)}  ${storyLabel}  ${chalk.dim(`${msgs.messageCount} messages, ${timeStr}`)}`);
        hasOutput = true;
      }
      if (!hasOutput) {
        console.log(chalk.dim('No sessions found.'));
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

  // Resume or resolve story
  type StoryRow = typeof stories.$inferSelect;
  let story: StoryRow | undefined;
  let isResuming = false;
  let resumedSessionId: number | null = null;
  let resumedMessages: Message[] = [];

  if (options.resume != null) {
    let sessionId: number;

    if (options.resume === true) {
      const recentSessions = db.select().from(sessions).orderBy(desc(sessions.id)).all();
      const sessionChoices: { id: number; label: string }[] = [];

      for (const s of recentSessions) {
        const msgs = db.select({
          messageCount: count(),
          startedAt: sql<number>`MIN(json_extract(${sessionMessages.content}, '$.timestamp'))`,
          lastActivity: sql<number>`MAX(json_extract(${sessionMessages.content}, '$.timestamp'))`,
        }).from(sessionMessages).where(eq(sessionMessages.sessionId, s.id)).get()!;

        if (msgs.messageCount === 0) continue;

        const storyRow = s.currentStoryId
          ? db.select().from(stories).where(eq(stories.id, s.currentStoryId)).get()
          : null;
        const storyLabel = storyRow ? `${storyRow.name} ${storyRow.title}` : 'no story';
        const startStr = msgs.startedAt ? formatTimeAgo(new Date(msgs.startedAt).toISOString()) : '?';
        const endStr = msgs.lastActivity ? formatTimeAgo(new Date(msgs.lastActivity).toISOString()) : '?';
        const timeStr = startStr === endStr ? startStr : `${startStr} – ${endStr}`;
        sessionChoices.push({
          id: s.id,
          label: `#${s.id}  ${storyLabel}  ${msgs.messageCount} messages, ${timeStr}`,
        });
      }

      if (sessionChoices.length === 0) {
        console.log(chalk.red('No sessions to resume.'));
        return;
      }

      try {
        sessionId = await select<number>({
          message: 'Select a session to resume',
          choices: sessionChoices.map((s) => ({ name: s.label, value: s.id })),
          loop: false,
          pageSize: 15,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'ExitPromptError') return;
        throw err;
      }
    } else {
      sessionId = parseInt(options.resume as string, 10);
      if (isNaN(sessionId)) {
        console.log(chalk.red('Invalid session id.'));
        return;
      }
    }

    const sessionRow = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!sessionRow) {
      console.log(chalk.red(`Session #${sessionId} not found.`));
      return;
    }

    const rows = db.select().from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id)
      .all();
    resumedMessages = rows.map((r) => JSON.parse(r.content) as Message);

    if (sessionRow.currentStoryId) {
      story = db.select().from(stories).where(eq(stories.id, sessionRow.currentStoryId)).get();
      if (!story) {
        console.log(chalk.red(`Story for session #${sessionId} has been deleted.`));
        return;
      }
    }

    isResuming = true;
    resumedSessionId = sessionId;

    console.log(chalk.green(`Resuming session #${sessionId} (${rows.length} messages)`));
    console.log('');
  } else if (options.new) {
    story = undefined;
  } else if (name) {
    story = db.select().from(stories).where(eq(stories.name, name)).get();
    if (!story) {
      console.log(chalk.red(`Story "${name}" not found.`));
      return;
    }
  } else {
    const allStories = db.select().from(stories).orderBy(desc(stories.updatedAt)).all();
    if (allStories.length === 0) {
      story = undefined;
    } else {
      const selection = await selectStoryInteractive(allStories, db);
      if (!selection) {
        return;
      }
      story = selection.action === 'open' ? selection.story : undefined;
    }
  }

  if (!isResuming) {
    if (story) {
      console.log(chalk.green(`Resuming story: ${story.title} ${chalk.cyan(story.name)}`));
      console.log('');
    } else {
      console.log(chalk.blue('Starting new story...'));
    }
  }

  const features = resolveFeatureFlags(config, {
    hasMusic: allMusic.length > 0,
    hasVoiceovers: allVoiceoversData.length > 0,
  });

  // Restore raw items from stored timeline
  let currentItems: TimelineItem[] = [];
  if (story?.timeline) {
    try {
      currentItems = z.array(TimelineItemSchema).parse(JSON.parse(story.timeline));
    } catch {
      // Ignore parse errors from old expanded format
    }
  }

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
    currentItems,
    agent: null as import('@mariozechner/pi-agent-core').Agent | null,
    timelineVersion: 0,
    sessionId: 0,
  };

  const agent = new StoryAgent({
    db,
    config,
    features,
    agentInstructions,
    story,
    toolsCtx,
    hint: options.hint,
    intro: options.intro,
    isResuming,
    resumedMessages,
    resumedSessionId,
  });

  await agent.run({
    videoAnalysisData,
    musicAnalysisData,
    voiceoverAnalysisData,
    generatedMusicData,
    storyline: story?.storyline ?? null,
  });
}
