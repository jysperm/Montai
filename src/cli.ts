#!/usr/bin/env -S npx tsx
import chalk from 'chalk';
import { Command } from 'commander';
import { analyzeCommand } from './commands/analyze.js';
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
  .option('--re-run <filename>', 'Re-analyze a specific video or music file by filename')
  .option('--show <filename>', 'Show the stored summary for a video or music file')
  .option('--list', 'List all videos and music files with analysis status')
  .option('--add-fact <text>', 'Add a project fact (AI merges into existing facts)')
  .option('--project', 'Show AI-generated project overview (regenerates if stale)')
  .action(analyzeCommand);

program
  .command('story [name]')
  .description('Interactive storyline + timeline editing session')
  .option('--new', 'Force create a new story')
  .option('--list', 'List all stories')
  .option('--hint <text>', 'Initial direction hint for new story')
  .option('--no-intro', 'Skip initial LLM summary, go straight to input')
  .action(storyCommand);

program
  .command('export [name]')
  .description('Export FCPXML from a timeline')
  .option('--fcp', 'Optimize for Final Cut Pro (default)')
  .option('--davinci', 'Optimize for DaVinci Resolve')
  .action(exportCommand);

program
  .command('render [name]')
  .description('Render video via Remotion')
  .action(renderCommand);

program
  .command('preview [name]')
  .description('Open Remotion Studio for preview')
  .action(studioCommand);

program.action(() => {
  printFullHelp(program);
});

await program.parseAsync();
