import chalk from 'chalk';
import { writeFileSync, mkdirSync } from 'fs';
import { basename, resolve } from 'path';
import { initDb } from '../db/index.js';
import { videos, music } from '../db/schema.js';
import { loadProjectConfig, loadExpandedTimelines } from '../utils/project.js';
import { generateFcpxml, type VideoFormatInfo, type AudioFormatInfo } from '../fcpxml/generate.js';
import { remapToArchived } from '../utils/archived-videos.js';
import { getVideoMetadata } from '../utils/ffprobe.js';

export async function exportCommand(name?: string, options?: { fcp?: boolean; davinci?: boolean; fromArchived?: boolean }) {
  const target: 'fcp' | 'davinci' = options?.davinci ? 'davinci' : 'fcp';
  const config = loadProjectConfig();
  const db = await initDb();

  let specs = loadExpandedTimelines(db, config, name);
  if (!specs) return;

  if (options?.fromArchived) {
    specs = remapToArchived(specs);
  }

  // When using archived files, probe them directly for accurate metadata;
  // otherwise use metadata from the database.
  const archivedMeta = new Map<string, VideoFormatInfo>();
  if (options?.fromArchived) {
    for (const spec of specs) {
      for (const clip of spec.clips) {
        const filename = basename(clip.sourceFile);
        if (!archivedMeta.has(filename)) {
          const meta = getVideoMetadata(clip.sourceFile);
          archivedMeta.set(filename, meta);
        }
      }
    }
  }

  const allVideos = db.select().from(videos).all();
  const allMusic = db.select().from(music).all();

  mkdirSync('fcpxml', { recursive: true });

  for (const spec of specs) {
    const videoMeta = new Map<string, VideoFormatInfo>();
    for (const clip of spec.clips) {
      const filename = basename(clip.sourceFile);
      if (!videoMeta.has(filename)) {
        const probed = archivedMeta.get(filename);
        if (probed) {
          videoMeta.set(filename, probed);
        } else {
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
    }

    // Build audio metadata map for music files
    const audioMetaMap = new Map<string, AudioFormatInfo>();
    for (const audio of spec.audioTracks ?? []) {
      if (!audio.sourceFile) continue;
      const filename = basename(audio.sourceFile);
      if (!audioMetaMap.has(filename)) {
        const track = allMusic.find(m => m.filename === filename);
        if (track) {
          audioMetaMap.set(filename, {
            durationSeconds: track.durationSeconds,
            channels: track.channels,
            sampleRate: track.sampleRate,
          });
        }
      }
    }

    const eventName = basename(resolve('.'));
    const fcpxml = generateFcpxml(spec, videoMeta, {
      eventName,
      projectTitle: spec.title,
      target,
    }, audioMetaMap);
    const outputPath = resolve(`fcpxml/${spec.name}.fcpxml`);
    writeFileSync(outputPath, fcpxml, 'utf-8');
    console.log(chalk.green(`FCPXML written to fcpxml/${spec.name}.fcpxml`));
  }
}
