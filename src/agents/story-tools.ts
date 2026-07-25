import { eq, desc } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { FileContent, ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { Agent } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import type { MontaiDb } from '../db/index.js';
import { stories, sessions, type videoAnalyses, type music, type musicAnalyses, type voiceovers, type voiceoverAnalyses } from '../db/schema.js';
import { renderPrompt, languageNames, type VideoAnalysisData, type MusicAnalysisData, type VoiceoverAnalysisData } from '../prompts/index.js';
import { resolveVoiceLanguage, type ProjectConfig } from '../schemas/project.js';
import type { FeatureFlags } from '../feature-flags.js';
import { uploadFileToGemini } from '../gemini/upload.js';
import { transcodeForUpload } from '../utils/transcode.js';
import { TimelineItemSchema, type TimelineItem } from '../schemas/timeline.js';
import { resolveTimeline } from '../schemas/timeline/resolve.js';
import { buildComputedTimelineData } from '../schemas/timeline/compute.js';
import { spliceTimelineItems, stripTimelineDefaults } from '../schemas/timeline/edit.js';
import { z } from 'zod';
import { generateMusicTrack } from '../generate/music.js';
import { generateVoiceoverTrack } from '../generate/tts.js';
import { countItemsByType, formatItemCounts, formatTimeAgo } from '../utils/format.js';
import { loadResolvedTimelines } from '../utils/project.js';
import { AGENT_PUBLIC_DIR, prepareAgentPublicDir, preparePublicDir } from '../remotion/public-dir.js';
import { resolveStartFrame, totalTimelineSeconds, renderStillFrame, renderRange, previewHash, stillHash } from '../utils/preview-render.js';
import { parseTimestamp, secondsToTimestamp } from '../utils/time.js';
import { formatSkillInstruction, loadedSkillNames, type Skill } from '../skills.js';

// Shared per-turn cap across all tools that inject media (videos/images) into
// the model context — Gemini limits how many file refs a single request can
// carry, so it must be a unified budget rather than per-tool.
const MAX_MEDIA_PER_TURN = 10;

export interface StoryToolsContext {
  db: MontaiDb;
  config: ProjectConfig;
  features: FeatureFlags;
  languageName: string;
  overlayLanguageNames: string;
  allVideos: { id: number; path: string; filename: string; durationSeconds?: number | null }[];
  allVideoAnalyses: (typeof videoAnalyses.$inferSelect)[];
  allMusic: (typeof music.$inferSelect)[];
  allMusicAnalyses: (typeof musicAnalyses.$inferSelect)[];
  allVoiceovers: (typeof voiceovers.$inferSelect)[];
  allVoiceoverAnalyses: (typeof voiceoverAnalyses.$inferSelect)[];
  currentStoryId: number | null;
  currentStoryName: string | null;
  currentItems: TimelineItem[];
  agent: Agent | null;
  timelineVersion: number;
  sessionId: number;
  skills: Skill[];
  loadedSkills: Set<string>;
}

export function getStoryTools(ctx: StoryToolsContext) {
  let mediaCountThisTurn = 0;

  // Resolve the current expanded timeline by re-loading from DB. Returns an
  // error string if the story has no clips yet (preview tools are meaningless
  // without a backbone) or resolveTimeline reports validation errors.
  function loadCurrentResolved() {
    const storyName = ctx.currentStoryName;
    if (!storyName) {
      return { error: 'No active story. Save the storyline and timeline first.' as const };
    }
    const result = loadResolvedTimelines(ctx.db, ctx.config, storyName, { quiet: true });
    if (result.errors.length > 0) {
      return { error: `Timeline has errors: ${result.errors.join('; ')}` as const };
    }
    if (result.timelines.length === 0 || result.timelines[0].clips.length === 0) {
      return { error: 'Timeline has no clips yet — add clips before requesting a preview.' as const };
    }
    return { spec: result.timelines[0] };
  }

  const updateStorylineTool = {
    name: 'updateStoryline',
    label: 'Update Storyline',
    description: `Save the current storyline. First call creates the story, subsequent calls update it. Text fields must be in ${ctx.languageName}.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Short kebab-case identifier (e.g. "lantern-festival"). Required on first call to create the story; omit on subsequent calls to keep the existing name' })),
      title: Type.Optional(Type.String({ description: `Neutral story label that names the main subject and activity, in ${ctx.languageName}. Required on first call; omit on subsequent calls to keep the existing title.` })),
      brief: Type.String({ description: `Free-form markdown for the storyline, capturing user requirements, creative direction, and current edit structure, in ${ctx.languageName}` }),
    }),
    async execute(
      _toolCallId: string,
      params: { name?: string; title?: string; brief: string },
    ) {
      const name = params.name ?? ctx.currentStoryName;

      if (!name) {
        throw new Error('Error: name is required when creating a new story.');
      }

      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`Error: name must be kebab-case (lowercase letters, numbers, hyphens). Got: "${name}"`);
      }

      if (!ctx.currentStoryId && !params.title) {
        throw new Error('Error: title is required when creating a new story.');
      }

      if (!ctx.currentStoryId) {
        const existingStory = ctx.db.select({ id: stories.id }).from(stories).where(eq(stories.name, name)).get();
        if (existingStory) {
          throw new Error(`Error: Story name "${name}" already exists. Choose a different name and retry updateStoryline.`);
        }
      }

      const now = new Date().toISOString();
      let savedTitle: string;

      if (ctx.currentStoryId) {
        const currentStory = ctx.db.select().from(stories).where(eq(stories.id, ctx.currentStoryId)).get();
        savedTitle = params.title ?? currentStory?.title ?? name;
        ctx.db.update(stories)
          .set({
            name,
            title: savedTitle,
            storyline: params.brief,
            updatedAt: now,
          })
          .where(eq(stories.id, ctx.currentStoryId))
          .run();
      } else {
        savedTitle = params.title!;
        const result = ctx.db.insert(stories)
          .values({
            name,
            title: savedTitle,
            storyline: params.brief,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        ctx.currentStoryId = result.id;
      }
      ctx.currentStoryName = name;

      ctx.db.update(sessions)
        .set({ currentStoryId: ctx.currentStoryId })
        .where(eq(sessions.id, ctx.sessionId))
        .run();

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Storyline saved: "${savedTitle}" (${name})`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const loadSkillTool = {
    name: 'loadSkill',
    label: 'Load Skill',
    description: 'Load a skill to get its specialized instructions. Available skills are listed in the system prompt.',
    parameters: Type.Object({
      name: Type.String({ description: 'The name of the skill to load.' }),
    }),
    async execute(_toolCallId: string, params: { name: string }) {
      const skill = ctx.skills.find((candidate) => candidate.name === params.name);
      if (!skill) {
        throw new Error(`Skill "${params.name}" is not available. Choose a name from the available-skills list.`);
      }

      if (!ctx.loadedSkills.has(skill.name)) {
        ctx.loadedSkills.add(skill.name);
        ctx.agent?.steer({
          role: 'user' as const,
          content: formatSkillInstruction(skill),
          timestamp: Date.now(),
        });
      }

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Skill "${skill.name}" is loaded and its instructions now apply.`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const updateTimelineTool = {
    name: 'updateTimeline',
    label: 'Update Timeline',
    description: `Update the timeline using splice semantics. index=0 + deleteCount=-1 for full replacement. Overlay text must be in ${ctx.overlayLanguageNames}.`,
    // items uses Type.Any() because Gemini's function calling doesn't support
    // complex JSON Schema features (oneOf, const, additionalProperties) needed
    // for a discriminated union. The LLM learns item structure from the system prompt instead.
    parameters: Type.Object({
      index: Type.Number({ description: 'Position to start modifying' }),
      deleteCount: Type.Number({ description: 'Number of items to remove (-1 = all from index)' }),
      items: Type.Optional(Type.Array(Type.Any(), { description: 'New items to insert at the position' })),
    }),
    async execute(
      _toolCallId: string,
      params: { index: number; deleteCount: number; items?: unknown[] },
    ) {
      let newItems: TimelineItem[] = [];
      if (params.items && params.items.length > 0) {
        try {
          newItems = z.array(TimelineItemSchema).parse(params.items);
        } catch (err) {
          throw new Error(`Item validation failed: ${err}`);
        }
      }

      // Sanitize + expand: validates references, clamps indices, detects auto-loop.
      // Sanitized items are written to DB; corrections are returned to the LLM.
      const splicedItems = spliceTimelineItems(ctx.currentItems, params.index, params.deleteCount, newItems);
      const { sanitizedItems: allItems, corrections, errors } = resolveTimeline(
        splicedItems, ctx.config, ctx.currentStoryName ?? 'unnamed', ctx.allVideos, undefined, ctx.allMusic, ctx.allVoiceovers,
      );

      // If voiceover validation errors exist, reject the update
      if (errors.length > 0) {
        throw new Error(`Timeline update rejected:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nPlease fix the issues and try again.`);
      }

      if (!ctx.currentStoryId) {
        throw new Error('Error: Call updateStoryline first to create a story before updating the timeline.');
      }

      ctx.currentItems = allItems;

      const now = new Date().toISOString();

      ctx.db.update(stories)
        .set({
          timeline: JSON.stringify(stripTimelineDefaults(ctx.currentItems)),
          updatedAt: now,
        })
        .where(eq(stories.id, ctx.currentStoryId))
        .run();

      ctx.timelineVersion++;

      const finalClipCount = ctx.currentItems.filter((i) => i.type === 'clip').length;
      const overlayCount = ctx.currentItems.filter((i) => i.type === 'overlay').length;
      const musicCount = ctx.currentItems.filter((i) => i.type === 'music').length;
      const voiceoverCount = ctx.currentItems.filter((i) => i.type === 'voiceover').length;
      const parts = [`${finalClipCount} clips`, `${overlayCount} overlays`];
      if (musicCount > 0) parts.push(`${musicCount} music`);
      if (voiceoverCount > 0) parts.push(`${voiceoverCount} voiceover`);
      let resultText = `Timeline updated: ${ctx.currentItems.length} items (${parts.join(', ')})`;
      if (corrections.length > 0) {
        resultText += `\nCorrections applied:\n${corrections.map((c) => `- ${c}`).join('\n')}`;
      }
      if (ctx.currentItems.length > 0) {
        resultText += '\n\n' + renderPrompt('computed-timeline', buildComputedTimelineData(ctx.currentItems));
      }
      const textContent: TextContent = {
        type: 'text' as const,
        text: resultText,
      };
      return { content: [textContent], details: {} };
    },
  };

  const watchSegmentTool = {
    name: 'watchSegment',
    label: 'Watch Segment',
    description: `Watch a specific segment of a SOURCE video. startTime and endTime use MM:SS or MM:SS.s timestamps matching the video analysis. Counts against the ${MAX_MEDIA_PER_TURN} media-per-turn budget.`,
    parameters: Type.Object({
      videoId: Type.Number({ description: 'The video ID' }),
      startTime: Type.String({ description: 'Segment start timestamp' }),
      endTime: Type.String({ description: 'Segment end timestamp' }),
      fps: Type.Optional(Type.Number({ minimum: 1, description: 'Sampling frame rate (default 1). Raise to 2-5 to inspect fast-changing visuals in short segments.' })),
    }),
    async execute(
      _toolCallId: string,
      params: { videoId: number; startTime: string; endTime: string; fps?: number },
    ) {
      mediaCountThisTurn++;
      if (mediaCountThisTurn > MAX_MEDIA_PER_TURN) {
        throw new Error(`Error: already injected ${MAX_MEDIA_PER_TURN} media items this turn (shared budget across watchSegment, previewFrame, previewFinalVideo). Wait for the next turn.`);
      }

      const video = ctx.allVideos.find((v) => v.id === params.videoId);
      if (!video) {
        throw new Error(`Error: Video ${params.videoId} not found`);
      }
      const startSeconds = parseTimestamp(params.startTime);
      const endSeconds = parseTimestamp(params.endTime);

      // Gemini returns a 500 INTERNAL (instead of a proper 400) for invalid
      // video ranges. Validate before uploading so the LLM retries with a valid range.
      if (startSeconds >= endSeconds) {
        throw new Error(`Error: startTime (${params.startTime}) must be less than endTime (${params.endTime}).`);
      }

      const duration = video.durationSeconds ?? 0;
      if (duration > 0 && startSeconds >= duration) {
        throw new Error(`Error: startTime ${params.startTime} is past the end of video ${video.filename} (duration ${secondsToTimestamp(duration)}). Pick a start within the video.`);
      }
      const clampedEnd = duration > 0 ? Math.min(endSeconds, duration) : endSeconds;
      const fps = params.fps ?? 1;
      if (fps < 1) {
        throw new Error('Error: fps must be >= 1.');
      }

      let transcoded: Awaited<ReturnType<typeof transcodeForUpload>>;
      let uploaded: Awaited<ReturnType<typeof uploadFileToGemini>>;
      try {
        transcoded = await transcodeForUpload(video.id, video.path, fps);
        uploaded = await uploadFileToGemini(transcoded.path);
      } catch (err) {
        throw new Error(`Error watching segment: ${err}`);
      }
      const fileContent: FileContent = {
        type: 'file',
        uri: uploaded.fileUri,
        mimeType: 'video/mp4',
        videoMetadata: {
          startOffset: `${startSeconds}s`,
          endOffset: `${clampedEnd}s`,
          ...(params.fps !== undefined ? { fps: params.fps } : {}),
        },
      };
      const textContent: TextContent = {
        type: 'text' as const,
        text: `Video segment from ${video.filename} (${params.startTime}-${params.endTime}) is now in context.`,
      };
      return { content: [textContent, fileContent], details: {} };
    },
  };

  const previewFrameTool = {
    name: 'previewFrame',
    label: 'Preview Frame',
    description: `Render a single frame of the CURRENT EDITED timeline (with crop, rotation, overlays, and other post effects applied) and view it as an image. Counts against the ${MAX_MEDIA_PER_TURN} media-per-turn budget.`,
    parameters: Type.Object({
      clipIndex: Type.Number({ description: '0-based clip index in the current timeline.' }),
      timeOffset: Type.Number({ description: 'Seconds within the clip. >= 0 = from clip start, < 0 = from clip end (same convention as overlay startOffset).' }),
    }),
    async execute(
      _toolCallId: string,
      params: { clipIndex: number; timeOffset: number },
    ) {
      mediaCountThisTurn++;
      if (mediaCountThisTurn > MAX_MEDIA_PER_TURN) {
        throw new Error(`Error: already injected ${MAX_MEDIA_PER_TURN} media items this turn (shared budget across watchSegment, previewFrame, previewFinalVideo). Wait for the next turn.`);
      }

      const loaded = loadCurrentResolved();
      if ('error' in loaded) {
        throw new Error(`Error: ${loaded.error}`);
      }
      const spec = loaded.spec;

      if (params.clipIndex < 0 || params.clipIndex >= spec.clips.length) {
        throw new Error(`Error: clipIndex ${params.clipIndex} out of range (timeline has ${spec.clips.length} clips, valid range 0-${spec.clips.length - 1}).`);
      }

      let buffer: Buffer;
      let frame: number;
      try {
        frame = resolveStartFrame(spec, params.clipIndex, params.timeOffset);
        // Cross-session disk cache: hash of (spec, frame). Reuses prior renders
        // until the timeline changes shape.
        const hash = stillHash(spec, frame);
        const outPath = resolve('.montai/agent-stills', `${hash}.png`);
        // The programmatic renderer has its own public directory so Agent
        // previews cannot replace media in a concurrently running Studio.
        preparePublicDir(spec, { publicDir: AGENT_PUBLIC_DIR });
        if (!existsSync(outPath)) {
          await renderStillFrame({ spec, frame, outPath });
        }
        buffer = readFileSync(outPath);
      } catch (err) {
        throw new Error(`Render failed: ${err instanceof Error ? err.message : err}`);
      }
      const image: ImageContent = {
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: 'image/png',
      };
      const text: TextContent = {
        type: 'text',
        text: `Rendered frame of clip ${params.clipIndex} at timeOffset ${params.timeOffset}s (frame ${frame} of the ${spec.fps}fps composition).`,
      };
      return { content: [text, image], details: {} };
    },
  };

  const previewFinalVideoTool = {
    name: 'previewFinalVideo',
    label: 'Preview Final Video',
    description: `Render a time range of the CURRENT EDITED timeline as a video and view the final composition. Defaults to the whole timeline at 1fps. Counts against the ${MAX_MEDIA_PER_TURN} media-per-turn budget.`,
    parameters: Type.Object({
      startSeconds: Type.Optional(Type.Number({ description: 'Absolute timeline start, in seconds (default 0).' })),
      endSeconds: Type.Optional(Type.Number({ description: 'Absolute timeline end, in seconds (default = end of timeline).' })),
      fps: Type.Optional(Type.Number({ minimum: 1, description: 'Sampling frame rate (default 1). Raise to 2-5 to inspect fast-changing visuals.' })),
    }),
    async execute(
      _toolCallId: string,
      params: { startSeconds?: number; endSeconds?: number; fps?: number },
    ) {
      mediaCountThisTurn++;
      if (mediaCountThisTurn > MAX_MEDIA_PER_TURN) {
        throw new Error(`Error: already injected ${MAX_MEDIA_PER_TURN} media items this turn (shared budget across watchSegment, previewFrame, previewFinalVideo). Wait for the next turn.`);
      }

      const loaded = loadCurrentResolved();
      if ('error' in loaded) {
        throw new Error(`Error: ${loaded.error}`);
      }
      const spec = loaded.spec;

      const totalSeconds = totalTimelineSeconds(spec);
      const startSeconds = Math.max(0, params.startSeconds ?? 0);
      const endSeconds = Math.min(totalSeconds, params.endSeconds ?? totalSeconds);
      const previewFps = params.fps ?? 1;

      if (endSeconds <= startSeconds) {
        throw new Error(`Error: empty range — startSeconds (${startSeconds}) must be < endSeconds (${endSeconds}); timeline is ${totalSeconds.toFixed(2)}s.`);
      }
      if (previewFps < 1) {
        throw new Error('Error: fps must be >= 1.');
      }

      let upload: Awaited<ReturnType<typeof uploadFileToGemini>>;
      try {
        prepareAgentPublicDir(spec, previewFps);
        const hash = previewHash(spec, startSeconds, endSeconds, previewFps);
        const outPath = resolve('.montai/agent-previews', `${hash}.mp4`);
        if (!existsSync(outPath)) {
          await renderRange({ spec, startSeconds, endSeconds, fps: previewFps, outPath });
        }
        upload = await uploadFileToGemini(outPath);
      } catch (err) {
        throw new Error(`Render failed: ${err instanceof Error ? err.message : err}`);
      }
      const durationSeconds = endSeconds - startSeconds;
      const file: FileContent = {
        type: 'file',
        uri: upload.fileUri,
        mimeType: 'video/mp4',
        videoMetadata: {
          startOffset: '0s',
          endOffset: `${durationSeconds.toFixed(2)}s`,
          fps: previewFps,
        },
      };
      const text: TextContent = {
        type: 'text',
        text: `Rendered preview ${startSeconds.toFixed(2)}s–${endSeconds.toFixed(2)}s of the edited timeline (${durationSeconds.toFixed(2)}s @ ${previewFps}fps${upload.cached ? ', cached upload' : ''}).`,
      };
      return { content: [text, file], details: {} };
    },
  };

  const getVideoAnalysisTool = {
    name: 'getVideoAnalysis',
    label: 'Get Video Analysis',
    description: 'Retrieve the stored analysis for a video.',
    parameters: Type.Object({
      videoId: Type.Number({ description: 'The video ID' }),
    }),
    async execute(
      _toolCallId: string,
      params: { videoId: number },
    ) {
      const analysis = ctx.allVideoAnalyses.find((s) => s.videoId === params.videoId);
      const video = ctx.allVideos.find((v) => v.id === params.videoId);
      const header = [video?.filename, video?.durationSeconds ? secondsToTimestamp(video.durationSeconds) : null]
        .filter(Boolean)
        .join(', ');
      const textContent: TextContent = {
        type: 'text' as const,
        text: analysis
          ? `Analysis for video ${params.videoId}${header ? ` (${header})` : ''}:\n${renderPrompt('video-analysis', {
              videoId: params.videoId,
              filename: video?.filename ?? 'unknown',
              duration: secondsToTimestamp(video?.durationSeconds ?? 0),
              overview: analysis.overview,
              location: analysis.location,
              timeOfDay: analysis.timeOfDay,
              segments: JSON.parse(analysis.segments),
              highlights: JSON.parse(analysis.highlights),
              technicalNotes: analysis.technicalNotes,
            } satisfies VideoAnalysisData).trim()}`
          : `No analysis found for video ${params.videoId}`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const getMusicAnalysisTool = {
    name: 'getMusicAnalysis',
    label: 'Get Music Analysis',
    description: 'Retrieve the stored analysis for a music track.',
    parameters: Type.Object({
      musicId: Type.Number({ description: 'The music ID' }),
    }),
    async execute(
      _toolCallId: string,
      params: { musicId: number },
    ) {
      const analysis = ctx.allMusicAnalyses.find((s) => s.musicId === params.musicId);
      const track = ctx.allMusic.find((m) => m.id === params.musicId);
      const header = [track?.filename, track?.durationSeconds ? secondsToTimestamp(track.durationSeconds) : null]
        .filter(Boolean)
        .join(', ');
      const textContent: TextContent = {
        type: 'text' as const,
        text: analysis
          ? `Analysis for music ${params.musicId}${header ? ` (${header})` : ''}:\n${renderPrompt('music-analysis', {
              musicId: params.musicId,
              filename: track?.filename ?? 'unknown',
              duration: secondsToTimestamp(track?.durationSeconds ?? 0),
              overview: analysis.overview,
              segments: JSON.parse(analysis.segments),
            } satisfies MusicAnalysisData).trim()}`
          : `No analysis found for music ${params.musicId}`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const getVoiceoverAnalysisTool = {
    name: 'getVoiceoverAnalysis',
    label: 'Get Voiceover Analysis',
    description: 'Retrieve the stored transcription for a voiceover recording.',
    parameters: Type.Object({
      voiceoverId: Type.Number({ description: 'The voiceover ID' }),
    }),
    async execute(
      _toolCallId: string,
      params: { voiceoverId: number },
    ) {
      const analysis = ctx.allVoiceoverAnalyses.find((a) => a.voiceoverId === params.voiceoverId);
      const vo = ctx.allVoiceovers.find((v) => v.id === params.voiceoverId);
      const header = [vo?.filename, vo?.durationSeconds ? secondsToTimestamp(vo.durationSeconds) : null]
        .filter(Boolean)
        .join(', ');
      const textContent: TextContent = {
        type: 'text' as const,
        text: analysis
          ? `Analysis for voiceover ${params.voiceoverId}${header ? ` (${header})` : ''}:\n${renderPrompt('voiceover-analysis', {
              voiceoverId: params.voiceoverId,
              filename: vo?.filename ?? 'unknown',
              durationSeconds: vo?.durationSeconds ?? 0,
              duration: secondsToTimestamp(vo?.durationSeconds ?? 0),
              overview: analysis.overview,
              transcription: JSON.parse(analysis.transcription),
            } satisfies VoiceoverAnalysisData).trim()}`
          : `No analysis found for voiceover ${params.voiceoverId}`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const generateMusicTool = {
    name: 'generateMusic',
    label: 'Generate Music',
    description: 'Generate instrumental background music via Lyria 3 AI. Produces a ~30 second track. Prompt must be in English.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'English description of the desired music: mood, genre, instruments, tempo. E.g. "gentle acoustic guitar, warm and nostalgic, medium tempo, suitable for a travel montage"' }),
    }),
    async execute(
      _toolCallId: string,
      params: { prompt: string },
    ) {
      let result: Awaited<ReturnType<typeof generateMusicTrack>>;
      try {
        result = await generateMusicTrack(ctx.db, params.prompt);
      } catch (err) {
        throw new Error(`Music generation failed: ${err instanceof Error ? err.message : err}`);
      }

      // Update the allMusic context so subsequent getMusicAnalysis / updateTimeline can reference it
      const existing = ctx.allMusic.find((m) => m.id === result.musicId);
      if (!existing) {
        ctx.allMusic.push({
          id: result.musicId,
          filename: `${result.path.split('/').pop()}`,
          path: result.path,
          md5: '',
          type: 'generated',
          generationPrompt: params.prompt,
          durationSeconds: result.durationSeconds,
          sampleRate: null,
          channels: null,
        });
      }

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Music generated successfully.\n- Music ID: ${result.musicId}\n- Duration: ${secondsToTimestamp(result.durationSeconds)}\n- Prompt: "${params.prompt}"\n\nUse musicId: ${result.musicId} in music timeline items to reference this track.`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const voiceLanguageCode = resolveVoiceLanguage(ctx.config);
  const voiceLanguageName = languageNames[voiceLanguageCode] ?? voiceLanguageCode;

  const generateVoiceoverTool = {
    name: 'generateVoiceover',
    label: 'Generate Voiceover',
    description: `Synthesize narration audio from a script via TTS, then transcribe it so it can be placed like a voiceover recording. Returns a voiceoverId, duration, and the timestamped transcription. Write the script in ${voiceLanguageName}.`,
    parameters: Type.Object({
      text: Type.String({ description: `The narration script, written in ${voiceLanguageName}. Keep it concise and generate one narrative beat at a time.` }),
      voice: Type.Optional(Type.String({ description: 'Narration voice: "female" (default) or "male". The concrete voice is chosen per provider and language.' })),
    }),
    async execute(
      _toolCallId: string,
      params: { text: string; voice?: string },
    ) {
      const voice = params.voice === 'male' ? 'male' : 'female';
      let result: Awaited<ReturnType<typeof generateVoiceoverTrack>>;
      try {
        result = await generateVoiceoverTrack(ctx.db, ctx.config, { text: params.text, voice });
      } catch (err) {
        throw new Error(`Voiceover generation failed: ${err instanceof Error ? err.message : err}`);
      }

      const { voiceover, analysis } = result;

      // Update context so getVoiceoverAnalysis and updateTimeline can reference the
      // new voiceover within the same turn.
      if (!ctx.allVoiceovers.find((v) => v.id === voiceover.id)) {
        ctx.allVoiceovers.push(voiceover);
      }
      if (!ctx.allVoiceoverAnalyses.find((a) => a.voiceoverId === voiceover.id)) {
        ctx.allVoiceoverAnalyses.push(analysis);
      }

      const durationSeconds = voiceover.durationSeconds ?? 0;
      const rendered = renderPrompt('voiceover-analysis', {
        voiceoverId: voiceover.id,
        filename: voiceover.filename,
        durationSeconds,
        duration: secondsToTimestamp(durationSeconds),
        overview: analysis.overview,
        transcription: JSON.parse(analysis.transcription),
      } satisfies VoiceoverAnalysisData).trim();

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Voiceover generated successfully.\n- Voiceover ID: ${voiceover.id}\n- Duration: ${secondsToTimestamp(durationSeconds)}\n\n${rendered}\n\nUse voiceoverId: ${voiceover.id} in a voiceover timeline item. Set clip durations after this so they cover the narration.`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const listStoriesTool = {
    name: 'listStories',
    label: 'List Stories',
    description: 'List all available stories with their names, titles, item counts, and last updated time.',
    parameters: Type.Object({}),
    async execute() {
      const allStories = ctx.db.select().from(stories).orderBy(desc(stories.updatedAt)).all();
      if (allStories.length === 0) {
        const textContent: TextContent = {
          type: 'text' as const,
          text: 'No stories found.',
        };
        return { content: [textContent], details: {} };
      }

      const lines = allStories.map((s) => {
        let status: string;
        if (s.timeline) {
          const items = JSON.parse(s.timeline) as Array<{ type: string }>;
          status = formatItemCounts(countItemsByType(items));
        } else {
          status = 'empty';
        }
        const current = s.id === ctx.currentStoryId ? ' (current)' : '';
        return `- ${s.name}: "${s.title}" [${status}] updated ${formatTimeAgo(s.updatedAt)}${current}`;
      });

      const textContent: TextContent = {
        type: 'text' as const,
        text: lines.join('\n'),
      };
      return { content: [textContent], details: {} };
    },
  };

  const switchStoryTool = {
    name: 'switchStory',
    label: 'Switch Story',
    description: 'Switch the current editing target to a different story, or start a new story.',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Target story name.' })),
      new: Type.Optional(Type.Boolean({ description: 'Set to true to start a new story.' })),
    }),
    async execute(
      _toolCallId: string,
      params: { name?: string; new?: boolean },
    ) {
      if (params.new) {
        ctx.currentStoryId = null;
        ctx.currentStoryName = params.name ?? null;
        ctx.currentItems = [];

        ctx.db.update(sessions)
          .set({ currentStoryId: null })
          .where(eq(sessions.id, ctx.sessionId))
          .run();

        if (ctx.agent) {
          const contextMessage = renderPrompt('story-switch', { name: ctx.currentStoryName, isNew: true });
          ctx.agent.state.messages = [...ctx.agent.state.messages, { role: 'user' as const, content: contextMessage, timestamp: Date.now() }];
        }

        const nameHint = ctx.currentStoryName ? ` Name "${ctx.currentStoryName}" is pre-set;` : '';
        const textContent: TextContent = {
          type: 'text' as const,
          text: `Starting new story.${nameHint} Use updateStoryline to create it.`,
        };
        return { content: [textContent], details: {} };
      }

      if (!params.name) {
        throw new Error('Error: name is required when new is not set.');
      }

      const story = ctx.db.select().from(stories).where(eq(stories.name, params.name)).get();
      if (!story) {
        throw new Error(`Error: Story "${params.name}" not found. Use listStories to see available stories.`);
      }

      ctx.currentStoryId = story.id;
      ctx.currentStoryName = story.name;
      ctx.currentItems = story.timeline ? z.array(TimelineItemSchema).parse(JSON.parse(story.timeline)) : [];

      ctx.db.update(sessions)
        .set({ currentStoryId: ctx.currentStoryId })
        .where(eq(sessions.id, ctx.sessionId))
        .run();

      // Inject storyline + timeline only (project-level context is already in conversation)
      if (ctx.agent) {
        const contextMessage = renderPrompt('story-switch', {
          name: story.name,
          storyline: story.storyline ?? null,
          timelineItems: ctx.currentItems.length > 0 ? JSON.stringify(stripTimelineDefaults(ctx.currentItems), null, 2) : null,
          computedTimeline: ctx.currentItems.length > 0 ? renderPrompt('computed-timeline', buildComputedTimelineData(ctx.currentItems)) : null,
        });
        ctx.agent.state.messages = [...ctx.agent.state.messages, { role: 'user' as const, content: contextMessage, timestamp: Date.now() }];
      }

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Switched to story "${params.name}".`,
      };
      return { content: [textContent], details: {} };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [updateStorylineTool, updateTimelineTool, watchSegmentTool, getVideoAnalysisTool, loadSkillTool];
  if (ctx.features.multiStory) {
    tools.push(listStoriesTool, switchStoryTool);
  }
  if (ctx.features.previewTools) {
    tools.push(previewFrameTool, previewFinalVideoTool);
  }
  if (ctx.features.music) {
    tools.push(getMusicAnalysisTool);
  }
  if (ctx.features.musicGeneration) {
    tools.push(generateMusicTool);
  }
  // Generated voiceovers also have a transcription, so getVoiceoverAnalysis is
  // useful even when there are no library recordings.
  if (ctx.features.voiceover || ctx.features.voiceoverGeneration) {
    tools.push(getVoiceoverAnalysisTool);
  }
  if (ctx.features.voiceoverGeneration) {
    tools.push(generateVoiceoverTool);
  }

  const requiredSkillsByTool = new Map<string, Skill[]>();
  for (const skill of ctx.skills) {
    for (const toolName of skill.unlockTools) {
      const requiredSkills = requiredSkillsByTool.get(toolName) ?? [];
      requiredSkills.push(skill);
      requiredSkillsByTool.set(toolName, requiredSkills);
    }
  }

  const guardedTools = tools.map((tool) => {
    const requiredSkills = requiredSkillsByTool.get(tool.name);
    if (!requiredSkills?.length || tool.name === 'loadSkill') return tool;

    const names = requiredSkills.map((skill) => JSON.stringify(skill.name));
    const skillLabel = requiredSkills.length === 1 ? `skill ${names[0]}` : `skills ${names.join(', ')}`;
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      description: `${tool.description} Requires loading ${skillLabel} with loadSkill before use.`,
      async execute(...args: unknown[]) {
        const loaded = loadedSkillNames(ctx.agent?.state.messages ?? []);
        const missing = requiredSkills.filter((skill) => !loaded.has(skill.name));
        if (missing.length > 0) {
          const missingNames = missing.map((skill) => JSON.stringify(skill.name));
          const missingLabel = missing.length === 1
            ? `skill ${missingNames[0]}`
            : `skills ${missingNames.join(', ')}`;
          throw new Error(
            `Tool ${JSON.stringify(tool.name)} requires ${missingLabel}. `
            + `Call loadSkill for ${missing.length === 1 ? 'this skill' : 'these skills'} first, `
            + 'then retry after the instructions have been added to the conversation.',
          );
        }
        return execute(...args);
      },
    };
  });

  return {
    tools: guardedTools,
    resetWatchCount() {
      mediaCountThisTurn = 0;
    },
  };
}
