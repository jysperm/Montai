import type * as readline from 'readline';

export type StoryInputResult = { text: string; slashMode: boolean };

export type StoryInputState = {
  text: string;
  cursor: number;
  slashMode: boolean;
  historyIndex: number;
  draft: StoryInputResult;
  escapeCount: number;
  xtermShiftEnterRemainder: number;
  pasting: boolean;
};

export type StoryInputAction =
  | { type: 'render' }
  | { type: 'submit'; result: StoryInputResult }
  | { type: 'cancel' }
  | { type: 'complete-slash' }
  | { type: 'none' };

export function createStoryInputState(historyLength: number): StoryInputState {
  return {
    text: '',
    cursor: 0,
    slashMode: false,
    historyIndex: historyLength,
    draft: { text: '', slashMode: false },
    escapeCount: 0,
    xtermShiftEnterRemainder: 0,
    pasting: false,
  };
}

export function rememberStoryInput(history: StoryInputResult[], text: string, slashMode: boolean) {
  const last = history[history.length - 1];
  if (!last || last.text !== text || last.slashMode !== slashMode) {
    history.push({ text, slashMode });
  }
}

export function handleStoryInputKey(
  state: StoryInputState,
  str: string | undefined,
  key: readline.Key,
  history: StoryInputResult[],
): StoryInputAction {
  if (key.name === 'paste-start') {
    state.pasting = true;
    return { type: 'none' };
  }
  if (key.name === 'paste-end') {
    state.pasting = false;
    return { type: 'render' };
  }

  if (state.pasting && str != null) {
    const pasted = str.replace(/\r\n?/g, '\n');
    insert(state, state.slashMode ? pasted.replace(/\n/g, ' ') : pasted);
    return { type: 'render' };
  }

  if (state.xtermShiftEnterRemainder > 0) {
    state.xtermShiftEnterRemainder -= str?.length ?? 1;
    return { type: 'render' };
  }

  const ctrlName = getCtrlKeyName(str, key);
  if (ctrlName) {
    return handleCtrlKey(state, ctrlName, history);
  }

  const metaName = getMetaKeyName(str, key);
  if (metaName) {
    return handleMetaKey(state, metaName);
  }

  if ((key.sequence ?? '') === '\x1b[27;2;') {
    state.xtermShiftEnterRemainder = 3;
    if (!state.slashMode) insert(state, '\n');
    return { type: 'render' };
  }

  if (isShiftEnter(str, key)) {
    if (!state.slashMode) insert(state, '\n');
    return { type: 'render' };
  }

  if (key.name === 'return' || key.name === 'enter' || str === '\r' || str === '\n') {
    return { type: 'submit', result: { text: state.text, slashMode: state.slashMode } };
  }

  if (key.name === 'backspace') {
    state.escapeCount = 0;
    if (state.slashMode && state.text.length === 0) {
      state.slashMode = false;
    } else {
      deleteBeforeCursor(state);
    }
    return { type: 'render' };
  }

  if (key.name === 'delete') {
    state.escapeCount = 0;
    deleteAtCursor(state);
    return { type: 'render' };
  }

  if (key.name === 'left') {
    state.escapeCount = 0;
    moveLeft(state);
    return { type: 'render' };
  }
  if (key.name === 'right') {
    state.escapeCount = 0;
    moveRight(state);
    return { type: 'render' };
  }
  if (key.name === 'up') {
    state.escapeCount = 0;
    return moveUp(state, history);
  }
  if (key.name === 'down') {
    state.escapeCount = 0;
    return moveDown(state, history);
  }
  if (key.name === 'home') {
    state.escapeCount = 0;
    state.cursor = 0;
    return { type: 'render' };
  }
  if (key.name === 'end') {
    state.escapeCount = 0;
    state.cursor = state.text.length;
    return { type: 'render' };
  }

  if (isEscapeKey(str, key)) {
    if (state.slashMode) {
      clearInput(state);
    } else if (state.escapeCount > 0) {
      clearInput(state);
    } else {
      state.escapeCount = 1;
    }
    return { type: 'render' };
  }

  if (key.name === 'tab' && state.slashMode) {
    state.escapeCount = 0;
    return { type: 'complete-slash' };
  }

  if (!key.ctrl && !key.meta && str && str >= ' ') {
    state.escapeCount = 0;
    if (!state.slashMode && state.text.length === 0 && state.cursor === 0 && str === '/') {
      state.slashMode = true;
    } else {
      insert(state, str);
    }
    return { type: 'render' };
  }

  return { type: 'none' };
}

export function applySlashCompletion(state: StoryInputState, completed: string | null) {
  if (completed != null) {
    state.text = completed;
    state.cursor = state.text.length;
  }
}

function handleCtrlKey(state: StoryInputState, ctrlName: string, history: StoryInputResult[]): StoryInputAction {
  state.escapeCount = 0;
  if (ctrlName === 'c') return { type: 'cancel' };
  if (ctrlName === 'd') {
    if (state.text.length === 0) return { type: 'cancel' };
    deleteAtCursor(state);
    return { type: 'render' };
  }
  if (ctrlName === 'a') state.cursor = 0;
  else if (ctrlName === 'e') state.cursor = state.text.length;
  else if (ctrlName === 'w') deleteWordBeforeCursor(state);
  else if (ctrlName === 'u') {
    state.text = state.text.slice(state.cursor);
    state.cursor = 0;
  } else if (ctrlName === 'k') state.text = state.text.slice(0, state.cursor);
  else if (ctrlName === 'b') moveLeft(state);
  else if (ctrlName === 'f') moveRight(state);
  else if (ctrlName === 'h') deleteBeforeCursor(state);
  else if (ctrlName === 'p') return previousHistory(state, history);
  else if (ctrlName === 'n') return nextHistory(state, history);
  else if (ctrlName === 'l') return { type: 'render' };
  else return { type: 'none' };
  return { type: 'render' };
}

function handleMetaKey(state: StoryInputState, metaName: string): StoryInputAction {
  state.escapeCount = 0;
  if (metaName === 'b' || metaName === 'left') moveWordLeft(state);
  else if (metaName === 'f' || metaName === 'right') moveWordRight(state);
  else if (metaName === 'd') deleteWordAfterCursor(state);
  else if (metaName === 'backspace' || metaName === 'delete') deleteWordBeforeCursor(state);
  else return { type: 'none' };
  return { type: 'render' };
}

function moveUp(state: StoryInputState, history: StoryInputResult[]): StoryInputAction {
  const nextCursor = getVerticalCursor(state.text, state.cursor, -1);
  if (nextCursor !== null) {
    state.cursor = nextCursor;
    return { type: 'render' };
  }
  return previousHistory(state, history);
}

function moveDown(state: StoryInputState, history: StoryInputResult[]): StoryInputAction {
  const nextCursor = getVerticalCursor(state.text, state.cursor, 1);
  if (nextCursor !== null) {
    state.cursor = nextCursor;
    return { type: 'render' };
  }
  return nextHistory(state, history);
}

function previousHistory(state: StoryInputState, history: StoryInputResult[]): StoryInputAction {
  if (history.length === 0) return { type: 'none' };
  if (state.historyIndex === history.length) state.draft = { text: state.text, slashMode: state.slashMode };
  state.historyIndex = Math.max(0, state.historyIndex - 1);
  setInput(state, history[state.historyIndex] ?? { text: '', slashMode: false });
  return { type: 'render' };
}

function nextHistory(state: StoryInputState, history: StoryInputResult[]): StoryInputAction {
  if (history.length === 0) return { type: 'none' };
  if (state.historyIndex < history.length - 1) {
    state.historyIndex++;
    setInput(state, history[state.historyIndex] ?? { text: '', slashMode: false });
  } else {
    state.historyIndex = history.length;
    setInput(state, state.draft);
  }
  return { type: 'render' };
}

function setInput(state: StoryInputState, next: StoryInputResult) {
  state.text = next.text;
  state.slashMode = next.slashMode;
  state.cursor = state.text.length;
}

function clearInput(state: StoryInputState) {
  state.text = '';
  state.cursor = 0;
  state.slashMode = false;
  state.escapeCount = 0;
}

function insert(state: StoryInputState, value: string) {
  state.text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  state.cursor += value.length;
}

function deleteBeforeCursor(state: StoryInputState) {
  if (state.cursor === 0) return;
  const prev = [...state.text.slice(0, state.cursor)].pop();
  if (!prev) return;
  state.text = state.text.slice(0, state.cursor - prev.length) + state.text.slice(state.cursor);
  state.cursor -= prev.length;
}

function deleteAtCursor(state: StoryInputState) {
  const next = [...state.text.slice(state.cursor)].shift();
  if (!next) return;
  state.text = state.text.slice(0, state.cursor) + state.text.slice(state.cursor + next.length);
}

function deleteWordBeforeCursor(state: StoryInputState) {
  const start = findWordStartBefore(state.text, state.cursor);
  state.text = state.text.slice(0, start) + state.text.slice(state.cursor);
  state.cursor = start;
}

function deleteWordAfterCursor(state: StoryInputState) {
  const end = findWordEndAfter(state.text, state.cursor);
  state.text = state.text.slice(0, state.cursor) + state.text.slice(end);
}

function moveLeft(state: StoryInputState) {
  const prev = [...state.text.slice(0, state.cursor)].pop();
  if (prev) state.cursor -= prev.length;
}

function moveRight(state: StoryInputState) {
  const next = [...state.text.slice(state.cursor)].shift();
  if (next) state.cursor += next.length;
}

function moveWordLeft(state: StoryInputState) {
  state.cursor = findWordStartBefore(state.text, state.cursor);
}

function moveWordRight(state: StoryInputState) {
  state.cursor = findWordEndAfter(state.text, state.cursor);
}

function findWordStartBefore(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1] ?? '')) i--;
  while (i > 0 && !/\s/.test(text[i - 1] ?? '')) i--;
  return i;
}

function findWordEndAfter(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i] ?? '')) i++;
  while (i < text.length && !/\s/.test(text[i] ?? '')) i++;
  return i;
}

function getVerticalCursor(text: string, cursor: number, direction: -1 | 1): number | null {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = offset + lines[i].length;
    if (cursor <= lineEnd || i === lines.length - 1) {
      const targetLine = i + direction;
      if (targetLine < 0 || targetLine >= lines.length) return null;
      const column = cursor - offset;
      const targetOffset = lines.slice(0, targetLine).reduce((sum, line) => sum + line.length + 1, 0);
      return targetOffset + Math.min(column, lines[targetLine].length);
    }
    offset = lineEnd + 1;
  }
  return null;
}

function isShiftEnter(str: string | undefined, key: readline.Key): boolean {
  const sequence = key.sequence ?? str ?? '';
  return (
    Boolean(key.shift && (key.name === 'return' || key.name === 'enter')) ||
    sequence === '\x1b[13;2u' ||
    (key as { code?: string }).code === '[13;2u' ||
    sequence === '\x1b[27;2;13~'
  );
}

function isEscapeKey(str: string | undefined, key: readline.Key): boolean {
  const sequence = key.sequence ?? str ?? '';
  return (
    key.name === 'escape' ||
    sequence === '\x1b' ||
    sequence === '\x1b[27u' ||
    sequence === '\x1b[27;1u'
  );
}

function getCtrlKeyName(str: string | undefined, key: readline.Key): string | null {
  if (key.ctrl && key.name) return key.name;

  const sequence = key.sequence ?? str ?? '';
  const match = /^\x1b\[(\d+);(\d+)u$/.exec(sequence);
  if (!match) return null;

  const codepoint = Number(match[1]);
  const modifiers = Number(match[2]) - 1;
  const hasCtrl = (modifiers & 4) !== 0;
  return hasCtrl ? String.fromCodePoint(codepoint).toLowerCase() : null;
}

function getMetaKeyName(str: string | undefined, key: readline.Key): string | null {
  if (key.meta && key.name) return key.name;

  const sequence = key.sequence ?? str ?? '';
  if (!sequence.startsWith('\x1b')) return null;

  const suffix = sequence.slice(1).toLowerCase();
  if (suffix === 'b' || suffix === 'f' || suffix === 'd') return suffix;
  if (suffix === '\x7f' || suffix === '[3~') return 'backspace';
  if (suffix === '[1;3d' || suffix === '[1;3c') return suffix.endsWith('d') ? 'left' : 'right';
  if (suffix === '[3;3~') return 'delete';
  return null;
}
