import { describe, expect, it } from 'vitest';
import {
  createStoryInputState,
  handleStoryInputKey,
  type StoryInputResult,
} from '../../src/agents/story-input.js';

function press(state: ReturnType<typeof createStoryInputState>, name: string, history: StoryInputResult[] = [], str?: string) {
  return handleStoryInputKey(state, str, { name } as never, history);
}

function typeText(state: ReturnType<typeof createStoryInputState>, text: string, history: StoryInputResult[] = []) {
  for (const ch of text) {
    handleStoryInputKey(state, ch, { name: ch } as never, history);
  }
}

describe('story input editing', () => {
  it('uses up and down for explicit multiline cursor movement before history', () => {
    const history = [{ text: 'previous', slashMode: false }];
    const state = createStoryInputState(history.length);
    typeText(state, 'abc', history);
    handleStoryInputKey(state, undefined, { name: 'return', shift: true } as never, history);
    typeText(state, 'def', history);

    press(state, 'up', history);
    expect(state.cursor).toBe(3);
    expect(state.text).toBe('abc\ndef');

    press(state, 'up', history);
    expect(state.text).toBe('previous');

    press(state, 'down', history);
    expect(state.text).toBe('abc\ndef');
    expect(state.cursor).toBe(7);
  });

  it('supports ctrl-p and ctrl-n for history', () => {
    const history = [{ text: 'one', slashMode: false }, { text: 'two', slashMode: false }];
    const state = createStoryInputState(history.length);

    handleStoryInputKey(state, undefined, { name: 'p', ctrl: true } as never, history);
    expect(state.text).toBe('two');

    handleStoryInputKey(state, undefined, { name: 'p', ctrl: true } as never, history);
    expect(state.text).toBe('one');

    handleStoryInputKey(state, undefined, { name: 'n', ctrl: true } as never, history);
    expect(state.text).toBe('two');
  });

  it('supports meta word movement and deletion', () => {
    const state = createStoryInputState(0);
    typeText(state, 'one two three');

    handleStoryInputKey(state, undefined, { name: 'b', meta: true } as never, []);
    expect(state.cursor).toBe('one two '.length);

    handleStoryInputKey(state, undefined, { name: 'backspace', meta: true } as never, []);
    expect(state.text).toBe('one three');

    handleStoryInputKey(state, undefined, { name: 'd', meta: true } as never, []);
    expect(state.text).toBe('one ');
  });

  it('uses escape to exit slash mode and double escape to clear normal input', () => {
    const state = createStoryInputState(0);
    typeText(state, '/render');
    expect(state.slashMode).toBe(true);

    handleStoryInputKey(state, '\x1b', {} as never, []);
    expect(state.slashMode).toBe(false);
    expect(state.text).toBe('');

    typeText(state, 'draft');
    handleStoryInputKey(state, undefined, { sequence: '\x1b[27;1u' } as never, []);
    expect(state.text).toBe('draft');

    press(state, 'escape');
    expect(state.text).toBe('');
  });

  it('keeps bracketed pasted newlines in normal mode and flattens them in slash mode', () => {
    const state = createStoryInputState(0);
    press(state, 'paste-start');
    handleStoryInputKey(state, 'a\nb', { name: 'a' } as never, []);
    press(state, 'paste-end');
    expect(state.text).toBe('a\nb');

    const slashState = createStoryInputState(0);
    typeText(slashState, '/');
    press(slashState, 'paste-start');
    handleStoryInputKey(slashState, 'switch one\nswitch two', { name: 's' } as never, []);
    press(slashState, 'paste-end');
    expect(slashState.text).toBe('switch one switch two');
  });
});
