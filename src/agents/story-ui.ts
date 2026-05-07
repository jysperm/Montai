import chalk from 'chalk';
import * as readline from 'readline';
import stringWidth from 'string-width';
import { eq, desc } from 'drizzle-orm';
import { existsSync, unlinkSync } from 'fs';
import type { MontaiDb } from '../db/index.js';
import { stories, storyMarks } from '../db/schema.js';
import { formatDuration, formatStoryLine, formatMarkLine, countItemsByType, formatItemCounts } from '../utils/format.js';

export function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatUserInput(text: string, isSlash = false): string {
  const cols = process.stdout.columns || 80;
  const prompt = isSlash ? chalk.cyan('/ ') : chalk.green('> ');
  const padRight = Math.max(0, cols - stringWidth('> ' + text));
  return prompt + chalk.bgHex('#303030')(text + ' '.repeat(padRight));
}

export function formatAssistantText(text: string): string {
  return text.trimEnd().replace(/\*\*(.+?)\*\*/g, (_, t: string) => chalk.bold(t));
}

export function printToolCall(toolName: string, args: Record<string, unknown>) {
  const check = chalk.green('✓');
  const label = chalk.green(toolName);

  switch (toolName) {
    case 'updateStoryline': {
      const title = args.title as string | undefined;
      const storyName = args.name as string | undefined;
      const narrative = args.narrative as string | undefined;
      console.log(`  ${check} ${label}: ${title ?? ''}  ${chalk.cyan(storyName ?? '')}`);
      if (narrative) {
        for (const line of narrative.split('\n')) {
          console.log(chalk.dim(`    ${line}`));
        }
      }
      console.log('');
      return;
    }
    case 'watchSegment': {
      const videoId = args.videoId as number;
      const startSec = args.startSeconds as number;
      const endSec = args.endSeconds as number;
      const dur = formatDuration(endSec - startSec);
      console.log(`  ${check} ${label}: video ${videoId} (${formatTimestamp(startSec)} - ${formatTimestamp(endSec)}, ${dur})`);
      return;
    }
    case 'updateTimeline': {
      const deleteCount = args.deleteCount as number;
      const newItems = (args.items ?? []) as Array<{ type: string }>;
      const addedCounts = countItemsByType(newItems);
      const hasAdded = newItems.length > 0;
      const hasDeleted = deleteCount !== 0;

      let summary: string;
      if (deleteCount === -1) {
        summary = `replaced with ${formatItemCounts(addedCounts)}`;
      } else if (hasAdded && hasDeleted) {
        summary = `updated ${formatItemCounts(addedCounts)}`;
      } else if (hasAdded) {
        summary = `added ${formatItemCounts(addedCounts)}`;
      } else if (hasDeleted) {
        summary = `deleted ${deleteCount} item${deleteCount !== 1 ? 's' : ''}`;
      } else {
        summary = 'no changes';
      }
      console.log(`  ${check} ${label}: ${summary}`);
      return;
    }
    case 'generateMusic': {
      const prompt = args.prompt as string;
      console.log(`  ${check} ${label}: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`)
      return;
    }
    case 'switchStory': {
      const targetName = args.name as string | undefined;
      const isNew = args.new as boolean | undefined;
      console.log(isNew ? `  ${check} ${label}: new story` : `  ${check} ${label}: ${chalk.cyan(targetName ?? '?')}`);
      return;
    }
    default:
      console.log(`  ${check} ${label}${args.videoId ? `: video ${args.videoId}` : args.musicId ? `: music ${args.musicId}` : args.voiceoverId ? `: voiceover ${args.voiceoverId}` : ''}`);
  }
}

type StoryRow = typeof stories.$inferSelect;
export type StorySelection = { action: 'new' } | { action: 'open'; story: StoryRow };

export async function selectStoryInteractive(allStories: StoryRow[], db: MontaiDb): Promise<StorySelection | null> {
  if (!process.stdin.isTTY) return null;

  const items = [...allStories];
  let cursor = 0;
  let deleteConfirm: number | null = null;

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l');

    let lineCount = 0;

    function render() {
      if (lineCount > 0) {
        process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
      }
      const lines: string[] = [];
      const hint = deleteConfirm !== null ? '' : chalk.dim('  (d: delete)');
      lines.push(`${chalk.green('?')} ${chalk.bold('Select a story')}${hint}`);
      for (let i = 0; i < items.length; i++) {
        const prefix = cursor === i ? chalk.cyan('❯ ') : '  ';
        const line = formatStoryLine(items[i]);
        if (deleteConfirm === i) {
          lines.push(`${prefix}${line}  ${chalk.red('Delete? (y to confirm)')}`);
        } else {
          lines.push(`${prefix}${line}`);
        }
      }
      const newPrefix = cursor === items.length ? chalk.cyan('❯ ') : '  ';
      lines.push(`${newPrefix}${chalk.bold('+ New story')}`);
      lineCount = lines.length;
      process.stdout.write(lines.join('\n') + '\n');
    }

    function finish(result: StorySelection | null) {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write('\x1b[?25h');
      if (lineCount > 0) {
        process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
      }
      resolve(result);
    }

    function onKeypress(_str: string | undefined, key: readline.Key) {
      if (key?.name === 'c' && key?.ctrl) {
        finish(null);
        return;
      }

      if (deleteConfirm !== null) {
        if (_str === 'y' || _str === 'Y') {
          const story = items[deleteConfirm];
          db.delete(stories).where(eq(stories.id, story.id)).run();
          const fcpxmlPath = `fcpxml/${story.name}.fcpxml`;
          if (existsSync(fcpxmlPath)) unlinkSync(fcpxmlPath);
          items.splice(deleteConfirm, 1);
          if (items.length === 0) {
            finish({ action: 'new' });
            return;
          }
          if (cursor >= items.length) cursor = items.length - 1;
        }
        deleteConfirm = null;
        render();
        return;
      }

      if (key?.name === 'up') {
        if (cursor > 0) cursor--;
        render();
      } else if (key?.name === 'down') {
        if (cursor < items.length) cursor++;
        render();
      } else if (key?.name === 'return') {
        if (cursor === items.length) {
          finish({ action: 'new' });
        } else {
          finish({ action: 'open', story: items[cursor] });
        }
      } else if ((_str === 'd' || _str === 'D') && cursor < items.length) {
        deleteConfirm = cursor;
        render();
      }
    }

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

type MarkRow = typeof storyMarks.$inferSelect;

export async function selectMarkInteractive(allMarks: MarkRow[], db: MontaiDb): Promise<MarkRow | null> {
  if (!process.stdin.isTTY) return null;
  if (allMarks.length === 0) return null;

  const items = [...allMarks];
  let cursor = 0;
  let deleteConfirm: number | null = null;
  let restoreConfirm: number | null = null;

  // The story TUI's interactive loop has its own keypress listener (for slash-mode
  // hint rendering) plus the readline interface itself listens for keypresses.
  // While the picker is up we strip them so only the picker's handler is active —
  // otherwise both render passes fight over the same screen rows and produce
  // doubled headers / garbled lines on arrow-key navigation.
  const suspendedListeners = process.stdin.listeners('keypress').slice() as Array<(...args: unknown[]) => void>;
  for (const l of suspendedListeners) process.stdin.removeListener('keypress', l);

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l');

    let lineCount = 0;

    function render() {
      if (lineCount > 0) {
        process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
      }
      const lines: string[] = [];
      const hint = deleteConfirm !== null || restoreConfirm !== null
        ? ''
        : chalk.dim('  (Enter: restore, d: delete)');
      lines.push(`${chalk.bold('Restore a mark')}${hint}`);
      for (let i = 0; i < items.length; i++) {
        const prefix = cursor === i ? chalk.cyan('❯ ') : '  ';
        const line = formatMarkLine(items[i]);
        if (deleteConfirm === i) {
          lines.push(`${prefix}${line}  ${chalk.red('Delete? (y to confirm)')}`);
        } else if (restoreConfirm === i) {
          lines.push(`${prefix}${line}  ${chalk.yellow('Restore? (y to confirm)')}`);
        } else {
          lines.push(`${prefix}${line}`);
        }
      }
      lineCount = lines.length;
      process.stdout.write(lines.join('\n') + '\n');
    }

    function finish(result: MarkRow | null) {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write('\x1b[?25h');
      if (lineCount > 0) {
        process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
      }
      for (const l of suspendedListeners) process.stdin.on('keypress', l);
      resolve(result);
    }

    function onKeypress(_str: string | undefined, key: readline.Key) {
      if (key?.name === 'c' && key?.ctrl) {
        finish(null);
        return;
      }
      if (key?.name === 'escape') {
        finish(null);
        return;
      }

      if (deleteConfirm !== null) {
        if (_str === 'y' || _str === 'Y') {
          const mark = items[deleteConfirm];
          db.delete(storyMarks).where(eq(storyMarks.id, mark.id)).run();
          items.splice(deleteConfirm, 1);
          if (items.length === 0) {
            finish(null);
            return;
          }
          if (cursor >= items.length) cursor = items.length - 1;
        }
        deleteConfirm = null;
        render();
        return;
      }

      if (restoreConfirm !== null) {
        if (_str === 'y' || _str === 'Y') {
          finish(items[restoreConfirm]);
          return;
        }
        restoreConfirm = null;
        render();
        return;
      }

      if (key?.name === 'up') {
        if (cursor > 0) cursor--;
        render();
      } else if (key?.name === 'down') {
        if (cursor < items.length - 1) cursor++;
        render();
      } else if (key?.name === 'return') {
        restoreConfirm = cursor;
        render();
      } else if ((_str === 'd' || _str === 'D') && cursor < items.length) {
        deleteConfirm = cursor;
        render();
      }
    }

    process.stdin.on('keypress', onKeypress);
    render();
  });
}
