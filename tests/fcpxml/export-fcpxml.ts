import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { generateFcpxml } from '../../src/fcpxml/generate.js';
import { audioMeta, expandForTimeline, listTimelineNames, outputDir, parseTimelineSpec, videoMeta, voiceoverMeta } from './utils.js';

const requested = process.argv.slice(2);
const specs = (requested.length > 0 ? requested : listTimelineNames()).map(parseTimelineSpec);

mkdirSync(outputDir, { recursive: true });

for (const { name, resolution, outputName } of specs) {
  const { timeline, corrections, errors } = expandForTimeline(name, resolution);
  if (errors.length > 0) {
    throw new Error(`${name} errors:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  if (corrections.length > 0) {
    console.log(`${name} corrections:\n${corrections.map((c) => `  - ${c}`).join('\n')}`);
  }

  const fcpxml = generateFcpxml(timeline, videoMeta, {
    eventName: 'Montai FCPXML Tests',
    projectTitle: outputName,
    target: 'fcp',
  }, audioMeta, voiceoverMeta);
  const outputPath = resolve(outputDir, `${outputName}.fcpxml`);
  writeFileSync(outputPath, fcpxml, 'utf-8');
  console.log(outputPath);
}
