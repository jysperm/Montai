import { eq } from 'drizzle-orm';
import type { FileContent, TextContent } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import type { MontaiDb } from '../db/index.js';
import { stories, type videoSummaries, type music, type musicSummaries } from '../db/schema.js';
import { langName } from '../prompts/index.js';
import type { ProjectConfig } from '../schemas/project.js';
import { serializeVideoSummary } from '../utils/project.js';
import { uploadVideoToGemini } from '../gemini/upload.js';
import { transcodeForUpload } from '../utils/transcode.js';
import {
  TimelineItemSchema,
  spliceTimelineItems,
  type TimelineItem,
} from '../schemas/timeline-items.js';
import { z } from 'zod';

const MAX_VIDEO_FILES_PER_TURN = 10;

export interface StoryToolsContext {
  db: MontaiDb;
  config: ProjectConfig;
  allVideos: { id: number; path: string; filename: string }[];
  allSummaries: (typeof videoSummaries.$inferSelect)[];
  allMusic: (typeof music.$inferSelect)[];
  allMusicSummaries: (typeof musicSummaries.$inferSelect)[];
  currentStoryId: number | null;
  currentItems: TimelineItem[];
}

export function getStoryTools(ctx: StoryToolsContext) {
  let watchCountThisTurn = 0;

  const updateStorylineTool = {
    name: 'updateStoryline',
    label: 'Update Storyline',
    description: `Save the current storyline. First call creates the story, subsequent calls update it. All fields must be in ${langName(ctx.config.language)}.`,
    parameters: Type.Object({
      name: Type.String({ description: 'Short kebab-case identifier (e.g. "lantern-festival")' }),
      title: Type.String({ description: `Human-readable title for the video, in ${langName(ctx.config.language)}` }),
      narrative: Type.String({ description: `Free-form markdown describing the edit plan, in ${langName(ctx.config.language)}` }),
    }),
    async execute(
      _toolCallId: string,
      params: { name: string; title: string; narrative: string },
    ) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(params.name)) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: `Error: name must be kebab-case (lowercase letters, numbers, hyphens). Got: "${params.name}"`,
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const now = new Date().toISOString();

      if (ctx.currentStoryId) {
        ctx.db.update(stories)
          .set({
            name: params.name,
            title: params.title,
            storyline: params.narrative,
            updatedAt: now,
          })
          .where(eq(stories.id, ctx.currentStoryId))
          .run();
      } else {
        const result = ctx.db.insert(stories)
          .values({
            name: params.name,
            title: params.title,
            storyline: params.narrative,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        ctx.currentStoryId = result.id;
      }

      const textContent: TextContent = {
        type: 'text' as const,
        text: `Storyline saved: "${params.title}" (${params.name})`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const updateTimelineTool = {
    name: 'updateTimeline',
    label: 'Update Timeline',
    description: `Update the timeline using splice semantics. index=0 + deleteCount=-1 for full replacement. Overlay text must be in ${ctx.config.effects.languages.map(langName).join(' and ')}.`,
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

      const allItems = spliceTimelineItems(ctx.currentItems, params.index, params.deleteCount, newItems);
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

      ctx.currentItems = allItems;

      if (!ctx.currentStoryId) {
        const errorText: TextContent = {
          type: 'text' as const,
          text: 'Error: Call updateStoryline first to create a story before updating the timeline.',
        };
        return { content: [errorText], details: {}, isError: true };
      }

      const now = new Date().toISOString();

      ctx.db.update(stories)
        .set({
          timeline: JSON.stringify(ctx.currentItems),
          updatedAt: now,
        })
        .where(eq(stories.id, ctx.currentStoryId))
        .run();

      const finalClipCount = ctx.currentItems.filter((i) => i.type === 'clip').length;
      const overlayCount = ctx.currentItems.filter((i) => i.type === 'overlay').length;
      const audioCount = ctx.currentItems.filter((i) => i.type === 'audio').length;
      const parts = [`${finalClipCount} clips`, `${overlayCount} overlays`];
      if (audioCount > 0) parts.push(`${audioCount} audio`);
      const textContent: TextContent = {
        type: 'text' as const,
        text: `Timeline updated: ${ctx.currentItems.length} items (${parts.join(', ')})`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const watchSegmentTool = {
    name: 'watchSegment',
    label: 'Watch Segment',
    description: `Watch a specific segment of a video. Maximum ${MAX_VIDEO_FILES_PER_TURN} segments per turn.`,
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

      const video = ctx.allVideos.find((v) => v.id === params.videoId);
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
    name: 'getVideoSummary',
    label: 'Get Video Summary',
    description: 'Retrieve the stored analysis summary for a video.',
    parameters: Type.Object({
      videoId: Type.Number({ description: 'The video ID' }),
    }),
    async execute(
      _toolCallId: string,
      params: { videoId: number },
    ) {
      const summary = ctx.allSummaries.find((s) => s.videoId === params.videoId);
      const textContent: TextContent = {
        type: 'text' as const,
        text: summary
          ? `Summary for video ${params.videoId}:\n${serializeVideoSummary(summary)}`
          : `No summary found for video ${params.videoId}`,
      };
      return { content: [textContent], details: {} };
    },
  };

  const tools = [updateStorylineTool, updateTimelineTool, watchSegmentTool, getVideoSummaryTool];

  return {
    tools,
    resetWatchCount() {
      watchCountThisTurn = 0;
    },
  };
}
