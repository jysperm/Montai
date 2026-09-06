import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

let cached: string | undefined;

// The version stamped on analysis records: `0.6.0` for an installed release,
// `0.6.0+5.g3871658.dirty` for a development checkout (SemVer build metadata
// carrying git describe's commit distance, short SHA and dirty marker).
export function montaiVersion(): string {
  if (cached === undefined) cached = resolveVersion();
  return cached;
}

function resolveVersion(): string {
  // npm never ships .git, so its presence marks a development checkout. Testing
  // for the directory rather than just letting git succeed matters: an installed
  // copy under node_modules sits inside the user's own working tree, and git
  // there would happily report their tags as ours.
  if (!existsSync(join(packageRoot, '.git'))) return pkg.version;

  let described: string;
  try {
    // --long keeps the tagged form uniform (`v0.6.0-0-g3871658` right on a tag),
    // --always falls back to a bare SHA when no tag is reachable (shallow clones).
    described = execFileSync('git', ['describe', '--tags', '--long', '--always', '--dirty', '--match', 'v*'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return pkg.version;
  }

  const match = /^(?:.+-(\d+)-g)?([0-9a-f]+)(-dirty)?$/.exec(described);
  if (!match) return pkg.version;

  const [, distance, sha, dirty] = match;
  return `${pkg.version}+${[distance, `g${sha}`, dirty && 'dirty'].filter(Boolean).join('.')}`;
}
