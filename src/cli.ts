#!/usr/bin/env -S npx tsx
import chalk from 'chalk';
import { Command } from 'commander';
import { analyzeCommand } from './commands/analyze.js';
import { storylineCommand } from './commands/storyline.js';
import { editCommand } from './commands/edit.js';
import { renderCommand } from './commands/render.js';
import { studioCommand } from './commands/studio.js';
import { exportCommand } from './commands/export.js';

function printFullHelp(program: Command) {
  console.log(`${chalk.bold('cutflow')} — AI-powered vlog auto-editing CLI\n`);

  function printCommands(commands: readonly Command[], prefix: string) {
    for (const cmd of commands) {
      if (cmd.name() === 'help') continue;
      const fullName = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
      const args = cmd.registeredArguments
        .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
        .join(' ');
      const usage = args ? `${fullName} ${args}` : fullName;
      console.log(`  ${chalk.cyan(usage)}`);
      console.log(`    ${cmd.description()}`);
      for (const opt of cmd.options) {
        console.log(`    ${chalk.dim(opt.flags)}  ${opt.description}`);
      }
      const subs = cmd.commands.filter((c) => c.name() !== 'help');
      if (subs.length > 0) {
        printCommands(subs, fullName);
      } else {
        console.log();
      }
    }
  }

  printCommands(program.commands, '');
}

const program = new Command();

program
  .name('cutflow')
  .description('AI-powered vlog auto-editing CLI')
  .version('0.1.0')
  .addHelpCommand(false)
  .helpOption(false);

program
  .command('analyze')
  .description(
    'Analyze videos: upload to Gemini, generate summaries'
  )
  .option('--re-run <filename>', 'Re-analyze a specific video by filename, overwriting existing summary')
  .option('--show <filename>', 'Show the stored summary for a video by filename')
  .option('--list', 'List all videos and their analysis status')
  .option('--add-fact <text>', 'Add a project fact (AI merges into existing facts)')
  .option('--project', 'Show AI-generated project overview (regenerates if stale)')
  .action(analyzeCommand);

program
  .command('storyline')
  .description('Generate a storyline from video summaries')
  .option('--hint <text>', 'Additional instruction for storyline generation')
  .action(storylineCommand);

program
  .command('edit')
  .description('Generate timeline with agent loop')
  .option('--storyline <id-or-codename>', 'Use a specific storyline by ID or codename')
  .action(editCommand);

program
  .command('export [name]')
  .description('Export FCPXML from a timeline. Omit name for latest.')
  .action(exportCommand);

const remotion = program
  .command('remotion')
  .description('Remotion preview and rendering')
  .addHelpCommand(false)
  .helpOption(false)
  .action(() => {
    printFullHelp(program);
  });

remotion
  .command('render [name]')
  .description('Render video via Remotion. Omit name for latest timeline.')
  .action(renderCommand);

remotion
  .command('studio [name]')
  .description('Open Remotion Studio for preview. Omit name for latest timeline.')
  .action(studioCommand);

program.action(() => {
  printFullHelp(program);
});

program.parse();
