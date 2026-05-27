import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { generateFcpxml } from '../../src/fcpxml/generate.js';
import {
  audioMeta,
  expandForTimeline,
  listTimelineNames,
  outputDir,
  videoMeta,
  voiceoverMeta,
} from './utils.js';

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : listTimelineNames();

mkdirSync(outputDir, { recursive: true });

for (const name of names) {
  const { timeline, corrections, errors } = expandForTimeline(name);
  if (errors.length > 0) {
    throw new Error(`${name} errors:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  if (corrections.length > 0) {
    console.log(`${name} corrections:\n${corrections.map((c) => `  - ${c}`).join('\n')}`);
  }

  const fcpxml = generateFcpxml(timeline, videoMeta, {
    eventName: 'Montai FCPXML Tests',
    projectTitle: timeline.title,
    target: 'fcp',
  }, audioMeta, voiceoverMeta);
  const outputPath = resolve(outputDir, `${name}.fcpxml`);
  writeFileSync(outputPath, fcpxml, 'utf-8');
  console.log(outputPath);
}
