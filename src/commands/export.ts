import chalk from 'chalk';
import { writeFileSync, mkdirSync } from 'fs';
import { basename } from 'path';
import { eq, desc } from 'drizzle-orm';
import { initDb } from '../db/index.js';
import { editSpecs, videos } from '../db/schema.js';
import type { EditSpec } from '../schemas/edit-spec.js';
import { generateFcpxml, type VideoFormatInfo } from '../fcpxml/generate.js';

export async function exportCommand(name?: string) {
  const db = await initDb();

  let specRow;
  if (name) {
    specRow = db.select().from(editSpecs).where(eq(editSpecs.name, name)).get();
  } else {
    specRow = db.select().from(editSpecs).orderBy(desc(editSpecs.id)).get();
  }

  if (!specRow) {
    console.log(
      chalk.red(
        name
          ? `Edit spec "${name}" not found.`
          : 'No edit specs found. Run "cutflow edit" first.',
      ),
    );
    return;
  }

  const spec = JSON.parse(specRow.spec) as EditSpec;

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
