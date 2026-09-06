import { createRequire } from 'module';
import chalk from 'chalk';
import { Command } from 'commander';
import updateNotifier from 'update-notifier';
import { loadGlobalEnv } from './utils/global-env.js';
import { analyzeCommand } from './commands/analyze.js';
import { montaiVersion } from './utils/version.js';
import { storyCommand } from './commands/story.js';
import { renderCommand } from './commands/render.js';
import { previewCommand } from './commands/preview.js';
import { exportCommand } from './commands/export.js';
import { archiveCommand } from './commands/archive.js';
import { projectCommand } from './commands/project.js';
import { cleanCommand } from './commands/clean.js';
import { skillsCommand } from './commands/skills.js';

loadGlobalEnv();

function printFullHelp(program: Command) {
  console.log(`${chalk.bold('montai')} — AI-powered video editing tool that extracts storylines from unscripted footage and generates edited vlogs\n`);

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

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

const notifier = updateNotifier({ pkg });
if (notifier.update) {
  console.error(
    chalk.yellow(`${chalk.bold('[!]')} Update available: ${chalk.cyan(notifier.update.current)} → ${chalk.cyan(notifier.update.latest)}. Run ${chalk.cyan(`npm i -g ${pkg.name}`)} to update.`),
  );
}

const program = new Command();

program
  .name('montai')
  .description('AI-powered video editing tool that extracts storylines from unscripted footage and generates edited vlogs')
  .version(montaiVersion())
  .addHelpCommand(false)
  .helpOption(false);

program
  .command('analyze')
  .description(
    'Transcode, upload and analyze videos'
  )
  .option('--refresh [filename]', 'Re-analyze the named file, or every analysis whose model or prompt no longer matches the current one')
  .option('--all', 'With --refresh, re-analyze everything rather than only outdated analyses')
  .option('-f, --force', 'Skip the confirmation prompt for --refresh --all')
  .option('--show <filename>', 'Show the stored summary for a video or music file')
  .option('--list', 'List all videos and music files with analysis status')
  .action(analyzeCommand);

program
  .command('project')
  .description('Show project overview and stats')
  .action(projectCommand);

program
  .command('skills')
  .description('List story-agent skills and their sources')
  .action(skillsCommand);

program
  .command('story [name]')
  .description('Interactive storyline + timeline editing session')
  .option('--new', 'Force create a new story')
  .option('--list', 'List all stories')
  .option('--hint <text>', 'Initial direction hint for new story')
  .option('--no-intro', 'Skip initial LLM summary, go straight to input')
  .option('--resume [session-id]', 'Resume a previous session')
  .option('--sessions', 'List historical sessions')
  .action(storyCommand);

program
  .command('export [name]')
  .description('Export FCPXML from a timeline')
  .option('--fcp', 'Optimize for Final Cut Pro (default)')
  .option('--davinci', 'Optimize for DaVinci Resolve')
  .option('--from-archived', 'Use archived videos as source')
  .action(exportCommand);

program
  .command('render [name]')
  .description('Render video via Remotion')
  .option('--from-archived', 'Use archived videos as source')
  .action(renderCommand);

program
  .command('preview [name]')
  .description('Open Remotion Studio for preview')
  .option('--from-archived', 'Use archived videos as source')
  .action(previewCommand);

program
  .command('archive')
  .description('Archive original video clips referenced by timelines (video files only)')
  .option('--encode [spec]', 'Encode: output | 720p,crf=20,fps=30,8bit (default: passthrough)')
  .option('--handles <seconds>', 'Seconds of handles to keep before/after each referenced clip (default: 2)', '2')
  .action(archiveCommand);

program
  .command('clean')
  .description('Remove generated cache files (.montai)')
  .action(cleanCommand);

program.action(() => {
  printFullHelp(program);
});

// Any --help/-h anywhere in argv prints the same full help as bare `montai`.
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  printFullHelp(program);
  process.exit(0);
}

await program.parseAsync();
