import chalk from 'chalk';
import { writeFileSync, mkdirSync } from 'fs';
import { basename, resolve } from 'path';
import { initDb } from '../db/index.js';
import { videos } from '../db/schema.js';
import { loadProjectConfig, loadExpandedTimelines } from '../utils/project.js';
import { generateFcpxml, type VideoFormatInfo } from '../fcpxml/generate.js';

export async function exportCommand(name?: string) {
  const config = loadProjectConfig();
  const db = await initDb();

  const specs = loadExpandedTimelines(db, config, name);
  if (!specs) return;

  const allVideos = db.select().from(videos).all();

  mkdirSync('fcpxml', { recursive: true });

  for (const spec of specs) {
    const videoMeta = new Map<string, VideoFormatInfo>();
    for (const clip of spec.clips) {
      const filename = basename(clip.sourceFile);
      if (!videoMeta.has(filename)) {
        const video = allVideos.find(v => v.filename === filename);
        if (video?.width && video?.height && video?.fpsNum && video?.fpsDen) {
          videoMeta.set(filename, {
            width: video.width, height: video.height,
            fpsNum: video.fpsNum, fpsDen: video.fpsDen,
            durationSeconds: video.durationSeconds,
            totalFrames: video.totalFrames,
            bitDepth: video.bitDepth,
            colorPrimaries: video.colorPrimaries, colorTransfer: video.colorTransfer,
            audioChannels: video.audioChannels, audioSampleRate: video.audioSampleRate,
            startTimecode: video.startTimecode,
          });
        }
      }
    }

    const eventName = basename(resolve('.'));
    const outputPath = resolve(`fcpxml/${spec.name}.fcpxml`);
    const fcpxml = generateFcpxml(spec, videoMeta, {
      eventName,
      projectTitle: spec.title,
      outputPath,
      colorSpace: config.output.colorSpace,
    });
    writeFileSync(outputPath, fcpxml, 'utf-8');
    console.log(chalk.green(`FCPXML written to fcpxml/${spec.name}.fcpxml`));
  }
}
