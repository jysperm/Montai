import chalk from 'chalk';
import * as readline from 'readline';
import stringWidth from 'string-width';
import { eq, desc } from 'drizzle-orm';
import { existsSync, unlinkSync } from 'fs';
import type { MontaiDb } from '../db/index.js';
import { stories, storyMarks } from '../db/schema.js';
import { formatDuration, formatStoryLine, formatMarkLine, countItemsByType, formatItemCounts } from '../utils/format.js';
import { timeToSeconds } from '../utils/time.js';
import {
  applySlashCompletion,
  createStoryInputState,
  handleStoryInputKey,
  rememberStoryInput,
  type StoryInputResult,
} from './story-input.js';

export function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatFpsSuffix(fps: unknown): string {
  return isFiniteNumber(fps) && fps > 1 ? `, ${fps} fps` : '';
}

function formatPreviewOffset(offset: unknown): string {
  if (!isFiniteNumber(offset)) return '+?';
  return offset >= 0 ? `+${offset}s` : `${offset}s`;
}

export function formatUserInput(text: string, isSlash = false): string {
  const cols = process.stdout.columns || 80;
  const prompt = isSlash ? chalk.cyan('/ ') : chalk.green('> ');
  const plainPrompt = isSlash ? '/ ' : '> ';
  const continuationPrompt = '  ';
  return text.split('\n').map((line, index) => {
    const linePrompt = index === 0 ? prompt : chalk.dim(continuationPrompt);
    const plainLinePrompt = index === 0 ? plainPrompt : continuationPrompt;
    const padRight = Math.max(0, cols - stringWidth(plainLinePrompt + line));
    return linePrompt + chalk.bgHex('#303030')(line + ' '.repeat(padRight));
  }).join('\n');
}

type SlashCommands = Record<string, { description: string }>;
const PROMPT_WIDTH = 2;

export class StoryInput {
  private db: MontaiDb;
  private slashCommands: SlashCommands;
  private slashCommandNames: string[];
  private history: StoryInputResult[] = [];

  constructor(opts: { db: MontaiDb; slashCommands: SlashCommands }) {
    this.db = opts.db;
    this.slashCommands = opts.slashCommands;
    this.slashCommandNames = Object.keys(this.slashCommands);
  }

  remember(text: string, slashMode: boolean) {
    rememberStoryInput(this.history, text, slashMode);
  }

  read(): Promise<StoryInputResult | null> {
    if (!process.stdin.isTTY) return Promise.resolve(null);

    return new Promise((resolve) => {
      readline.emitKeypressEvents(process.stdin);
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write('\x1b[?25h\x1b[>1u\x1b[?2004h');

      const state = createStoryInputState(this.history.length);
      let renderedRows = 0;
      let renderedCursorRow = 0;
      let finished = false;

      const render = () => {
        if (renderedRows > 0) {
          const rowsBelowCursor = renderedRows - 1 - renderedCursorRow;
          if (rowsBelowCursor > 0) readline.moveCursor(process.stdout, 0, rowsBelowCursor);
          readline.cursorTo(process.stdout, 0);
          if (renderedRows > 1) readline.moveCursor(process.stdout, 0, -(renderedRows - 1));
          readline.clearScreenDown(process.stdout);
        }

        const hint = state.slashMode
          ? (state.text.startsWith('switch ') ? this.formatSwitchHint(state.text.slice('switch '.length)) : this.formatSlashHint(state.text))
          : '';
        process.stdout.write((hint ? hint + '\n' : '') + this.formatInput(state.text, state.slashMode));

        const hintRows = hint ? this.getTerminalRows(hint) : 0;
        const inputRows = this.getTerminalRows(this.formatPlainInput(state.text));
        const cursorPosition = this.getCursorPosition(state.text, state.cursor, hintRows);
        renderedRows = hintRows + inputRows;
        renderedCursorRow = cursorPosition.row;

        const bottomRow = renderedRows - 1;
        if (renderedCursorRow !== bottomRow) {
          readline.moveCursor(process.stdout, 0, renderedCursorRow - bottomRow);
        }
        readline.cursorTo(process.stdout, cursorPosition.col);
      };

      const finish = (result: StoryInputResult | null) => {
        if (finished) return;
        finished = true;
        process.stdin.removeListener('keypress', onKeypress);
        process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdout.write('\x1b[?2004l\x1b[<u');
        if (renderedRows > 0) {
          const rowsBelowCursor = renderedRows - 1 - renderedCursorRow;
          if (rowsBelowCursor > 0) readline.moveCursor(process.stdout, 0, rowsBelowCursor);
          readline.cursorTo(process.stdout, 0);
          if (renderedRows > 1) readline.moveCursor(process.stdout, 0, -(renderedRows - 1));
          readline.clearScreenDown(process.stdout);
        }
        resolve(result);
      };

      const onKeypress = (str: string | undefined, key: readline.Key) => {
        const action = handleStoryInputKey(state, str, key, this.history);
        if (action.type === 'cancel') {
          finish(null);
        } else if (action.type === 'submit') {
          finish(action.result);
        } else if (action.type === 'complete-slash') {
          applySlashCompletion(state, this.completeSlashInput(state.text));
          render();
        } else if (action.type === 'render') {
          render();
        }
      };

      process.stdin.on('keypress', onKeypress);
      render();
    });
  }

  private getTerminalRows(text: string): number {
    const cols = process.stdout.columns || 80;
    return text.split('\n').reduce((rows, line) => {
      const width = stringWidth(line);
      return rows + Math.max(1, Math.ceil(width / cols));
    }, 0);
  }

  private formatInput(text: string, slashMode: boolean): string {
    const prompt = slashMode ? chalk.cyan('/ ') : chalk.green('> ');
    return text.split('\n').map((line, index) => {
      const prefix = index === 0 ? prompt : ' '.repeat(PROMPT_WIDTH);
      return prefix + line;
    }).join('\n');
  }

  private formatPlainInput(text: string): string {
    return text.split('\n').map((line) => ' '.repeat(PROMPT_WIDTH) + line).join('\n');
  }

  private getCursorPosition(text: string, cursor: number, hintRows: number) {
    const cols = process.stdout.columns || 80;
    const beforeCursor = this.formatPlainInput(text.slice(0, cursor)).split('\n');
    let row = hintRows;
    for (const line of beforeCursor.slice(0, -1)) {
      row += this.getTerminalRows(line);
    }
    const width = stringWidth(beforeCursor[beforeCursor.length - 1] ?? '');
    let rowOffset = Math.floor(width / cols);
    let col = width % cols;
    if (width > 0 && col === 0) {
      rowOffset--;
      col = cols;
    }
    return { row: row + rowOffset, col };
  }

  private completeSlashInput(line: string): string | null {
    if (line === 'switch') return 'switch ';
    if (line.startsWith('switch ')) {
      const partial = line.slice('switch '.length).toLowerCase();
      const allStoryNames = this.db.select({ name: stories.name }).from(stories).all().map((s) => s.name);
      const hit = allStoryNames.find((n) => n.startsWith(partial));
      return hit ? `switch ${hit}` : null;
    }
    const partial = line.toLowerCase();
    if (this.slashCommandNames.includes(partial)) return null;
    return this.slashCommandNames.find((c) => c.startsWith(partial)) ?? null;
  }

  private formatSlashHint(filter: string): string {
    return chalk.dim('[tab] to complete: ') + this.slashCommandNames.map((name) => {
      const matched = !filter || name.startsWith(filter.toLowerCase());
      const label = '/' + name;
      const desc = this.slashCommands[name].description;
      return matched ? `${chalk.cyan(label)} ${chalk.dim(desc)}` : chalk.dim(`${label} ${desc}`);
    }).join('  ');
  }

  private formatSwitchHint(filter: string): string {
    const allStories = this.db.select().from(stories).orderBy(desc(stories.updatedAt)).all();
    if (allStories.length === 0) {
      return chalk.dim('enter a name to create a new story');
    }
    return chalk.dim('[tab] ') + allStories.map((s) => {
      const matched = !filter || s.name.startsWith(filter.toLowerCase());
      return matched ? `${chalk.cyan(s.name)} ${chalk.dim(s.title)}` : chalk.dim(`${s.name} ${s.title}`);
    }).join('  ') + chalk.dim(' or enter a new name');
  }
}

export function formatAssistantText(text: string): string {
  return text.trimEnd().replace(/\*\*(.+?)\*\*/g, (_, t: string) => chalk.bold(t));
}

export function printToolCall(toolName: string, args: Record<string, unknown>, error?: string) {
  const check = error ? chalk.red('✗') : chalk.green('✓');
  const label = error ? chalk.red(toolName) : chalk.green(toolName);

  switch (toolName) {
    case 'updateStoryline': {
      if (!error) {
        const title = args.title as string | undefined;
        const storyName = args.name as string | undefined;
        const brief = args.brief as string | undefined;
        console.log(`  ${check} ${label}: ${title ?? ''}  ${chalk.cyan(storyName ?? '')}`);
        if (brief) {
          for (const line of brief.split('\n')) {
            console.log(chalk.dim(`    ${line}`));
          }
        }
        console.log('');
        return;
      } else {
        break;
      }
    }
    case 'watchSegment': {
      if (!error) {
        const videoId = args.videoId as number;
        const startLabel = args.startTime as string;
        const endLabel = args.endTime as string;
        const startSec = timeToSeconds(startLabel);
        const endSec = timeToSeconds(endLabel);
        const dur = formatDuration(endSec - startSec);
        console.log(`  ${check} ${label}: video ${videoId} (${startLabel} - ${endLabel}, ${dur}${formatFpsSuffix(args.fps)})`);
        return;
      } else {
        break;
      }
    }
    case 'updateTimeline': {
      if (!error) {
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
      } else {
        break;
      }
    }
    case 'previewFrame': {
      if (!error) {
        const clipIndex = args.clipIndex as number | undefined;
        console.log(`  ${check} ${label}: clip ${clipIndex ?? '?'}${formatPreviewOffset(args.timeOffset)}`);
        return;
      } else {
        break;
      }
    }
    case 'previewFinalVideo': {
      if (!error) {
        const startSec = isFiniteNumber(args.startSeconds) ? args.startSeconds : 0;
        const endSec = args.endSeconds;
        const range = isFiniteNumber(endSec)
          ? `${formatTimestamp(startSec)} - ${formatTimestamp(endSec)}, ${formatDuration(endSec - startSec)}`
          : `${formatTimestamp(startSec)} - end`;
        console.log(`  ${check} ${label}: ${range}${formatFpsSuffix(args.fps)}`);
        return;
      } else {
        break;
      }
    }
    case 'generateMusic': {
      const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
      const promptDisplay = prompt
        ? `"${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`
        : undefined;
      if (!error) {
        console.log(`  ${check} ${label}${promptDisplay ? `: ${promptDisplay}` : ''}`);
        return;
      } else {
        if (promptDisplay) error = `${promptDisplay}: ${error}`;
        break;
      }
    }
    case 'switchStory': {
      if (!error) {
        const targetName = args.name as string | undefined;
        const isNew = args.new as boolean | undefined;
        console.log(isNew ? `  ${check} ${label}: new story` : `  ${check} ${label}: ${chalk.cyan(targetName ?? '?')}`);
        return;
      } else {
        break;
      }
    }
    default:
      if (!error) {
        console.log(`  ${check} ${label}${args.videoId ? `: video ${args.videoId}` : args.musicId ? `: music ${args.musicId}` : args.voiceoverId ? `: voiceover ${args.voiceoverId}` : ''}`);
        return;
      } else {
        break;
      }
  }

  console.log(`  ${check} ${label}: ${error}`);
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
      process.stdin.pause();
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
      process.stdin.pause();
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
