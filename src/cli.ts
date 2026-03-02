#!/usr/bin/env -S npx tsx
import chalk from 'chalk';
import { Command } from 'commander';
import { analyzeCommand } from './commands/analyze.js';
import { storylineCommand } from './commands/storyline.js';
import { editCommand } from './commands/edit.js';
import { storyCommand } from './commands/story.js';
import { renderCommand } from './commands/render.js';
import { studioCommand } from './commands/studio.js';
import { exportCommand } from './commands/export.js';

function printFullHelp(program: Command) {
  console.log(`${chalk.bold('montai')} — AI-powered tool that extracts storylines from unscripted footage and generates edited vlogs\n`);

  function printCommands(commands: readonly Command[], indent: number) {
    const pad = ' '.repeat(indent);
    for (const cmd of commands) {
      if (cmd.name() === 'help') continue;
      const args = cmd.registeredArguments
        .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
        .join(' ');
      const usage = args ? `${cmd.name()} ${args}` : cmd.name();
      console.log(`${pad}${chalk.cyan(usage)}  ${cmd.description()}`);
      for (const opt of cmd.options) {
        console.log(`${pad}  ${chalk.dim(opt.flags)}  ${opt.description}`);
      }
      const subs = cmd.commands.filter((c) => c.name() !== 'help');
      if (subs.length > 0) {
        console.log();
        printCommands(subs, indent + 2);
      } else {
        console.log();
      }
    }
  }

  printCommands(program.commands, 2);
}

const program = new Command();

program
  .name('montai')
  .description('AI-powered tool that extracts storylines from unscripted footage and generates edited vlogs')
  .version('0.1.0')
  .addHelpCommand(false)
  .helpOption(false);

program
  .command('analyze')
  .description(
    'Transcode, upload and analyze videos'
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
  .command('story [name]')
  .description('Interactive storyline + timeline editing session')
  .option('--new', 'Force create a new story')
  .option('--list', 'List all stories')
  .option('--hint <text>', 'Initial direction hint for new story')
  .action(storyCommand);

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

await program.parseAsync();
