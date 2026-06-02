import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import createDebug from 'debug';
import { parse } from 'dotenv';

export const GLOBAL_ENV_PATH = join(homedir(), '.config/montai/env');

export function loadGlobalEnv(path = GLOBAL_ENV_PATH, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;

  const values = parse(readFileSync(path, 'utf8'));
  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value;
      loadedKeys.push(key);
    }
  }

  if (env.DEBUG) {
    createDebug.enable(env.DEBUG);
  }

  const debug = createDebug('montai:env');
  debug('Loaded global env from %s: %s', path, loadedKeys.length > 0 ? loadedKeys.join(', ') : 'no new variables');
}
