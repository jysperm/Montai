import { eq, desc } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { FileContent, ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { Agent } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import type { MontaiDb } from '../db/index.js';
import { stories, sessions, type videoAnalyses, type music, type musicAnalyses, type voiceovers, type voiceoverAnalyses } from '../db/schema.js';
import { renderPrompt, type VideoAnalysisData, type MusicAnalysisData, type VoiceoverAnalysisData } from '../prompts/index.js';
import type { ProjectConfig } from '../schemas/project.js';
import type { FeatureFlags } from '../feature-flags.js';
import { uploadFileToGemini } from '../gemini/upload.js';
import { transcodeForUpload } from '../utils/transcode.js';
import { TimelineItemSchema, spliceTimelineItems, expandTimeline, stripTimelineDefaults, buildComputedTimelineData, type TimelineItem } from '../schemas/timeline-items.js';
import { z } from 'zod';
import { generateMusicTrack } from '../lyria/generate.js';
import { countItemsByType, formatItemCounts, formatTimeAgo } from '../utils/format.js';
import { loadExpandedTimelines } from '../utils/project.js';
import { preparePublicDir } from '../remotion/public-dir.js';
import { resolveStartFrame, totalTimelineSeconds, renderStillFrame, renderRange, previewHash, stillHash } from '../utils/preview-render.js';

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
}

export function getStoryTools(ctx: StoryToolsContext) {
  let mediaCountThisTurn = 0;

  // Resolve the current expanded timeline by re-loading from DB. Returns an
  // error string if the story has no clips yet (preview tools are meaningless
  // without a backbone) or expandTimeline reports validation errors.
  function loadCurrentExpanded() {
    const storyName = ctx.currentStoryName;
    if (!storyName) {
      return { error: 'No active story. Save the storyline and timeline first.' as const };
    }
    const result = loadExpandedTimelines(ctx.db, ctx.config, storyName, { quiet: true });
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
    description: `Save the current storyline. First call creates the story, subsequent calls update it. All fields must be in ${ctx.languageName}.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Short kebab-case identifier (e.g. "lantern-festival"). Required on first call to create the story; omit on subsequent calls to keep the existing name' })),
      title: Type.String({ description: `Human-readable title for the video, in ${ctx.languageName}` }),
      narrative: Type.String({ description: `Free-form markdown describing the edit plan, in ${ctx.languageName}` }),
    }),
    async execute(
      _toolCallId: string,
      params: { name?: string; title: string; narrative: string },
    ) {
      const name = params.name ?? ctx.currentStoryName;

      if (!name) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: 'Error: name is required when creating a new story.',
        };
        return { content: [errorText], details: {}, isError: true };
      }

      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: name must be kebab-case (lowercase letters, numbers, hyphens). Got: "${name}"`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const now = new Date().toISOString();

      if (ctx.currentStoryId) {
        ctx.db.update(stories)
          .set({
            name,
            title: params.title,
            storyline: params.narrative,
            updatedAt: now,
          })
          .where(eq(stories.id, ctx.currentStoryId))
          .run();
      } else {
        const result = ctx.db.insert(stories)
          .values({
            name,
            title: params.title,
            storyline: params.narrative,
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
        text: `Storyline saved: "${params.title}" (${name})`,
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
          const errorText: TextContent = {
            type: 'text' as const,
            text: `Item validation failed: ${err}`,
          };
          return { content: [errorText], details: {}, isError: true };
        }
      }

      // Sanitize + expand: validates references, clamps indices, detects auto-loop.
      // Sanitized items are written to DB; corrections are returned to the LLM.
      const splicedItems = spliceTimelineItems(ctx.currentItems, params.index, params.deleteCount, newItems);
      const { sanitizedItems: allItems, corrections, errors } = expandTimeline(
        splicedItems, ctx.config, ctx.currentStoryName ?? 'unnamed', ctx.allVideos, undefined, ctx.allMusic, ctx.allVoiceovers,
      );

      // If voiceover validation errors exist, reject the update
      if (errors.length > 0) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Timeline update rejected:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nPlease fix the issues and try again.`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      if (!ctx.currentStoryId) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: 'Error: Call updateStoryline first to create a story before updating the timeline.',
        };
        return { content: [errorText], details: {}, isError: true };
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
    description: `Watch a specific segment of a SOURCE video. Counts against the ${MAX_MEDIA_PER_TURN} media-per-turn budget.`,
    parameters: Type.Object({
      videoId: Type.Number({ description: 'The video ID' }),
      startSeconds: Type.Number({ description: 'Start time in seconds' }),
      endSeconds: Type.Number({ description: 'End time in seconds' }),
      fps: Type.Optional(Type.Number({ minimum: 1, description: 'Sampling frame rate (default 1). Raise to 2-5 to inspect fast-changing visuals in short segments.' })),
    }),
    async execute(
      _toolCallId: string,
      params: { videoId: number; startSeconds: number; endSeconds: number; fps?: number },
    ) {
      mediaCountThisTurn++;
      if (mediaCountThisTurn > MAX_MEDIA_PER_TURN) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: already injected ${MAX_MEDIA_PER_TURN} media items this turn (shared budget across watchSegment, previewFrame, previewFinalVideo). Wait for the next turn.`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const video = ctx.allVideos.find((v) => v.id === params.videoId);
      if (!video) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: Video ${params.videoId} not found`,
        };
        return { content: [errorText], details: {} };
      }

      // Gemini returns a 500 INTERNAL (instead of a proper 400) for invalid
      // video ranges. Validate before uploading so the LLM retries with a valid range.
      if (params.startSeconds >= params.endSeconds) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: startSeconds (${params.startSeconds}s) must be less than endSeconds (${params.endSeconds}s).`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const duration = video.durationSeconds ?? 0;
      if (duration > 0 && params.startSeconds >= duration) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: startSeconds ${params.startSeconds}s is past the end of video ${video.filename} (duration ${duration}s). Pick a start within the video.`,
        };
        return { content: [errorText], details: {}, isError: true };
      }
      const clampedEnd = duration > 0 ? Math.min(params.endSeconds, duration) : params.endSeconds;
      const fps = params.fps ?? 1;
      if (fps < 1) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: 'Error: fps must be >= 1.',
        };
        return { content: [errorText], details: {}, isError: true };
      }

      try {
        const transcoded = await transcodeForUpload(video.id, video.path, fps);
        const uploaded = await uploadFileToGemini(transcoded.path);
        const fileContent: FileContent = {
          type: 'file',
          uri: uploaded.fileUri,
          mimeType: 'video/mp4',
          videoMetadata: {
            startOffset: `${params.startSeconds}s`,
            endOffset: `${clampedEnd}s`,
            ...(params.fps !== undefined ? { fps: params.fps } : {}),
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

  const previewFrameTool = {
    name: 'previewFrame',
    label: 'Preview Frame',
    description: `Render a single frame of the CURRENT EDITED timeline (with crop, rotation, overlays, and other post effects applied) and view it as an image. Use this to verify how an effect actually looks at a specific moment. Counts against the ${MAX_MEDIA_PER_TURN} media-per-turn budget.`,
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
        return { content: [{ type: 'text' as const, text: `Error: already injected ${MAX_MEDIA_PER_TURN} media items this turn (shared budget across watchSegment, previewFrame, previewFinalVideo). Wait for the next turn.` } satisfies TextContent], details: {}, isError: true };
      }

      const loaded = loadCurrentExpanded();
      if ('error' in loaded) {
        return { content: [{ type: 'text' as const, text: `Error: ${loaded.error}` } satisfies TextContent], details: {}, isError: true };
      }
      const spec = loaded.spec;

      if (params.clipIndex < 0 || params.clipIndex >= spec.clips.length) {
        return { content: [{ type: 'text' as const, text: `Error: clipIndex ${params.clipIndex} out of range (timeline has ${spec.clips.length} clips, valid range 0-${spec.clips.length - 1}).` } satisfies TextContent], details: {}, isError: true };
      }

      try {
        const frame = resolveStartFrame(spec, params.clipIndex, params.timeOffset);
        // Cross-session disk cache: hash of (spec, frame). Reuses prior renders
        // until the timeline changes shape.
        const hash = stillHash(spec, frame);
        const outPath = resolve('.montai/.cache/stills', `${hash}.png`);
        // preparePublicDir is needed even on cache hit so that a follow-up
        // previewFinalVideo (which also uses the bundle's public/) finds media.
        preparePublicDir(spec);
        if (!existsSync(outPath)) {
          await renderStillFrame({ spec, frame, outPath });
        }
        const buffer = readFileSync(outPath);
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
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Render failed: ${err instanceof Error ? err.message : err}` } satisfies TextContent], details: {}, isError: true };
      }
    },
  };

  const previewFinalVideoTool = {
    name: 'previewFinalVideo',
    label: 'Preview Final Video',
    description: `Render a time range of the CURRENT EDITED timeline as a video and view the final composition. Use this to get an overall, end-to-end preview of how the edit plays out. Defaults to the whole timeline at 1fps. Heavier than previewFrame — prefer previewFrame for single-moment checks. Counts against the ${MAX_MEDIA_PER_TURN} media-per-turn budget.`,
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
        return { content: [{ type: 'text' as const, text: `Error: already injected ${MAX_MEDIA_PER_TURN} media items this turn (shared budget across watchSegment, previewFrame, previewFinalVideo). Wait for the next turn.` } satisfies TextContent], details: {}, isError: true };
      }

      const loaded = loadCurrentExpanded();
      if ('error' in loaded) {
        return { content: [{ type: 'text' as const, text: `Error: ${loaded.error}` } satisfies TextContent], details: {}, isError: true };
      }
      const spec = loaded.spec;

      const totalSeconds = totalTimelineSeconds(spec);
      const startSeconds = Math.max(0, params.startSeconds ?? 0);
      const endSeconds = Math.min(totalSeconds, params.endSeconds ?? totalSeconds);
      const previewFps = params.fps ?? 1;

      if (endSeconds <= startSeconds) {
        return { content: [{ type: 'text' as const, text: `Error: empty range — startSeconds (${startSeconds}) must be < endSeconds (${endSeconds}); timeline is ${totalSeconds.toFixed(2)}s.` } satisfies TextContent], details: {}, isError: true };
      }
      if (previewFps < 1) {
        return { content: [{ type: 'text' as const, text: 'Error: fps must be >= 1.' } satisfies TextContent], details: {}, isError: true };
      }

      try {
        preparePublicDir(spec);
        const hash = previewHash(spec, startSeconds, endSeconds, previewFps);
        const outPath = resolve('.montai/.cache/previews', `${hash}.mp4`);
        if (!existsSync(outPath)) {
          await renderRange({ spec, startSeconds, endSeconds, fps: previewFps, outPath });
        }
        const upload = await uploadFileToGemini(outPath);
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
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Render failed: ${err instanceof Error ? err.message : err}` } satisfies TextContent], details: {}, isError: true };
      }
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
      const header = [video?.filename, video?.durationSeconds ? `${video.durationSeconds}s` : null]
        .filter(Boolean)
        .join(', ');
      const textContent: TextContent = {
        type: 'text' as const,
        text: analysis
          ? `Analysis for video ${params.videoId}${header ? ` (${header})` : ''}:\n${renderPrompt('video-analysis', {
              videoId: params.videoId,
              filename: video?.filename ?? 'unknown',
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
      const textContent: TextContent = {
        type: 'text' as const,
        text: analysis
          ? `Analysis for music ${params.musicId}:\n${renderPrompt('music-analysis', {
              musicId: params.musicId,
              filename: track?.filename ?? 'unknown',
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
      const textContent: TextContent = {
        type: 'text' as const,
        text: analysis
          ? `Analysis for voiceover ${params.voiceoverId}:\n${renderPrompt('voiceover-analysis', {
              voiceoverId: params.voiceoverId,
              filename: vo?.filename ?? 'unknown',
              durationSeconds: vo?.durationSeconds ?? 0,
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
    description: 'Generate instrumental background music via Lyria 2 AI. Produces a ~30 second WAV track. Prefer reusing existing music (from Music Library or previously generated) before generating new tracks. Prompt must be in English.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'English description of the desired music: mood, genre, instruments, tempo. E.g. "gentle acoustic guitar, warm and nostalgic, medium tempo, suitable for a travel montage"' }),
    }),
    async execute(
      _toolCallId: string,
      params: { prompt: string },
    ) {
      try {
        const result = await generateMusicTrack(ctx.db, params.prompt);

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
          text: `Music generated successfully.\n- Music ID: ${result.musicId}\n- Duration: ${result.durationSeconds} seconds\n- Prompt: "${params.prompt}"\n\nUse musicId: ${result.musicId} in music timeline items to reference this track.`,
        };
        return { content: [textContent], details: {} };
      } catch (err) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Music generation failed: ${err instanceof Error ? err.message : err}`,
        };
        return { content: [errorText], details: {}, isError: true };
      }
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
        const errorText: TextContent = {
          type: 'text' as const,
          text: 'Error: name is required when new is not set.',
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const story = ctx.db.select().from(stories).where(eq(stories.name, params.name)).get();
      if (!story) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: Story "${params.name}" not found. Use listStories to see available stories.`,
        };
        return { content: [errorText], details: {}, isError: true };
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
  const tools: any[] = [updateStorylineTool, updateTimelineTool, watchSegmentTool, getVideoAnalysisTool, listStoriesTool, switchStoryTool];
  if (ctx.features.previewTools) {
    tools.push(previewFrameTool, previewFinalVideoTool);
  }
  if (ctx.features.music) {
    tools.push(getMusicAnalysisTool);
  }
  if (ctx.features.musicGeneration) {
    tools.push(generateMusicTool);
  }
  if (ctx.features.voiceover) {
    tools.push(getVoiceoverAnalysisTool);
  }

  return {
    tools,
    resetWatchCount() {
      mediaCountThisTurn = 0;
    },
  };
}
