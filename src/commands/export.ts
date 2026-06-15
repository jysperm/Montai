import chalk from 'chalk';
import { writeFileSync, mkdirSync } from 'fs';
import { basename, resolve } from 'path';
import { initDb, type MontaiDb } from '../db/index.js';
import { videos, music, voiceovers } from '../db/schema.js';
import { loadProjectConfig, loadResolvedTimelines } from '../utils/project.js';
import { generateFcpxml, type VideoFormatInfo, type AudioFormatInfo } from '../fcpxml/generate.js';
import { remapToArchived } from '../utils/archived-videos.js';
import { getVideoMetadata } from '../utils/ffprobe.js';
import type { ResolvedTimeline } from '../schemas/timeline.js';

export async function exportCommand(name?: string, options?: { fcp?: boolean; davinci?: boolean; fromArchived?: boolean }) {
  const target: 'fcp' | 'davinci' = options?.davinci ? 'davinci' : 'fcp';
  const config = loadProjectConfig();
  const db = await initDb();

  let { timelines: specs } = loadResolvedTimelines(db, config, name);
  if (specs.length === 0) return;

  let archivedMeta: Map<string, VideoFormatInfo> | undefined;
  if (options?.fromArchived) {
    specs = remapToArchived(specs);
    archivedMeta = new Map();
    for (const spec of specs) {
      for (const clip of spec.clips) {
        const filename = basename(clip.sourceFile);
        if (!archivedMeta.has(filename)) {
          archivedMeta.set(filename, getVideoMetadata(clip.sourceFile));
        }
      }
    }
  }

  exportFcpxmlFiles(specs, db, target, archivedMeta);

  for (const spec of specs) {
    console.log(chalk.green(`FCPXML written to fcpxml/${spec.name}.fcpxml`));
  }
}

export function exportFcpxmlFiles(
  specs: ResolvedTimeline[],
  db: MontaiDb,
  target: 'fcp' | 'davinci' = 'fcp',
  archivedMeta?: Map<string, VideoFormatInfo>,
): void {
  const allVideos = db.select().from(videos).all();
  const allMusic = db.select().from(music).all();
  const allVoiceovers = db.select().from(voiceovers).all();

  mkdirSync('fcpxml', { recursive: true });

  for (const spec of specs) {
    const videoMeta = new Map<string, VideoFormatInfo>();
    for (const clip of spec.clips) {
      const filename = basename(clip.sourceFile);
      if (!videoMeta.has(filename)) {
        const probed = archivedMeta?.get(filename);
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

    const voiceoverMetaMap = new Map<string, AudioFormatInfo>();
    for (const vo of spec.voiceoverTracks ?? []) {
      if (!vo.sourceFile) continue;
      const filename = basename(vo.sourceFile);
      if (!voiceoverMetaMap.has(filename)) {
        const track = allVoiceovers.find(v => v.filename === filename);
        if (track) {
          voiceoverMetaMap.set(filename, {
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
    }, audioMetaMap, voiceoverMetaMap);
    const outputPath = resolve(`fcpxml/${spec.name}.fcpxml`);
    writeFileSync(outputPath, fcpxml, 'utf-8');
  }
}
