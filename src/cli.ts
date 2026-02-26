#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { analyzeCommand } from './commands/analyze.js';
import { storylineCommand } from './commands/storyline.js';
import { editCommand } from './commands/edit.js';
import { renderCommand } from './commands/render.js';
import { studioCommand } from './commands/studio.js';
import { exportCommand } from './commands/export.js';

const program = new Command();

program
  .name('cutflow')
  .description('AI-powered vlog auto-editing CLI')
  .version('0.1.0');

program
  .command('analyze')
  .description(
    'Analyze videos: upload to Gemini, generate summaries, update project summary'
  )
  .option('--re-run <filename>', 'Re-analyze a specific video by filename, overwriting existing summary')
  .option('--show <filename>', 'Show the stored summary for a video by filename')
  .action(analyzeCommand);

program
  .command('storyline')
  .description('Generate a storyline from video summaries')
  .option('--hint <text>', 'Additional instruction for storyline generation')
  .action(storylineCommand);

program
  .command('edit')
  .description('Generate edit spec with agent loop')
  .option('--storyline <id>', 'Use a specific storyline by ID')
  .action(editCommand);

program
  .command('export [name]')
  .description('Export FCPXML from an edit spec. Omit name for latest.')
  .action(exportCommand);

const remotion = program
  .command('remotion')
  .description('Remotion preview and rendering');

remotion
  .command('render [name]')
  .description('Render video via Remotion. Omit name for latest edit spec.')
  .action(renderCommand);

remotion
  .command('studio [name]')
  .description('Open Remotion Studio for preview. Omit name for latest edit spec.')
  .action(studioCommand);

program.parse();
