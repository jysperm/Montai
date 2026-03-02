import chalk from 'chalk';
import { writeFileSync, mkdirSync } from 'fs';
import { basename } from 'path';
import { eq, desc, sql } from 'drizzle-orm';
import { initDb } from '../db/index.js';
import { timelines, stories, videos } from '../db/schema.js';
import type { Timeline } from '../schemas/timeline.js';
import { generateFcpxml, type VideoFormatInfo } from '../fcpxml/generate.js';

export async function exportCommand(name?: string) {
  const db = await initDb();

  let specJson: string | undefined;
  if (name) {
    const timelineRow = db.select().from(timelines).where(eq(timelines.name, name)).get();
    if (timelineRow) {
      specJson = timelineRow.spec;
    } else {
      const storyRow = db.select().from(stories).where(eq(stories.name, name)).get();
      if (storyRow?.timeline) {
        specJson = storyRow.timeline;
      }
    }
  } else {
    const timelineRow = db.select().from(timelines).orderBy(desc(timelines.id)).get();
    if (timelineRow) {
      specJson = timelineRow.spec;
    } else {
      const storyRow = db.select({ timeline: stories.timeline })
        .from(stories)
        .where(sql`${stories.timeline} IS NOT NULL`)
        .orderBy(desc(stories.id))
        .get();
      if (storyRow?.timeline) {
        specJson = storyRow.timeline;
      }
    }
  }

  if (!specJson) {
    console.log(
      chalk.red(
        name
          ? `Timeline "${name}" not found.`
          : 'No timelines found. Run "montai edit" or "montai story" first.',
      ),
    );
    return;
  }

  const spec = JSON.parse(specJson) as Timeline;

  const videoMeta = new Map<string, VideoFormatInfo>();
  for (const clip of spec.clips) {
    const filename = basename(clip.sourceFile);
    if (!videoMeta.has(filename)) {
      const video = db.select().from(videos).where(eq(videos.filename, filename)).get();
      if (video?.width && video?.height && video?.fpsNum && video?.fpsDen) {
        videoMeta.set(filename, {
          width: video.width, height: video.height,
          fpsNum: video.fpsNum, fpsDen: video.fpsDen,
          durationSeconds: video.durationSeconds,
          totalFrames: video.totalFrames,
          bitDepth: video.bitDepth, colorSpace: video.colorSpace,
          colorPrimaries: video.colorPrimaries, colorTransfer: video.colorTransfer,
          audioChannels: video.audioChannels, audioSampleRate: video.audioSampleRate,
          startTimecode: video.startTimecode,
        });
      }
    }
  }

  mkdirSync('fcpxml', { recursive: true });
  const fcpxml = generateFcpxml(spec, videoMeta);
  writeFileSync(`fcpxml/${spec.name}.fcpxml`, fcpxml, 'utf-8');
  console.log(chalk.green(`FCPXML written to fcpxml/${spec.name}.fcpxml`));
}
