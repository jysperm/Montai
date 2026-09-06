// Brings drizzle/ into the shape a release ships: generate what src/db/schema.ts still has
// uncovered, then collapse everything unreleased into one migration named after the version in
// package.json. Doing nothing means the tree is already releasable, which is how release.sh uses it.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const journalPath = join(root, 'drizzle', 'meta', '_journal.json');

const readJournal = () => JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
const writeJournal = (journal: { entries: JournalEntry[] }) =>
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
const snapshotPath = (entry: JournalEntry) =>
  join(root, 'drizzle', 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`);
const isHead = (entry: JournalEntry) => entry.tag.endsWith('_head');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

// Without stdin drizzle-kit cannot ask whether a column was renamed: it prints the question,
// generates nothing and still exits 0, so the outcome has to be read from its output.
const { stdout, stderr } = spawnSync('npx', ['drizzle-kit', 'generate', '--name', 'head'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = `${stdout}${stderr}`;
if (!output.includes('No schema changes') && !output.includes('Your SQL migration file')) {
  console.error(output);
  console.error('Error: drizzle-kit needs input to generate, run `npm run db:generate` and answer it');
  process.exit(1);
}

// A migration already named after this version is pending too while the version is unreleased, so
// that squashing twice folds it back in rather than adding another file.
const isReleased = spawnSync('git', ['rev-parse', `v${version}`], { cwd: root, stdio: 'ignore' }).status === 0;
const isPending = (entry: JournalEntry) => isHead(entry) || (!isReleased && entry.tag.endsWith(`_v${version}`));

const journal = readJournal();
const pending = journal.entries.filter(isPending);

if (isReleased && pending.length > 0) {
  console.error(`Error: v${version} is already released, bump the version in package.json first`);
  process.exit(1);
}

if (!pending.some(isHead) && pending.length <= 1) {
  console.log(`Nothing to squash, ${journal.entries[journal.entries.length - 1].tag}.sql is current.`);
  process.exit(0);
}

// `when` is the high-water mark databases record, so a published entry's value can never change
// afterwards. Keeping the last pending migration's is what makes databases that applied all of them
// skip the squashed one; initDb repairs those that applied only some.
const when = pending[pending.length - 1].when;

for (const entry of pending) {
  rmSync(join(root, 'drizzle', `${entry.tag}.sql`));
  rmSync(snapshotPath(entry));
}
writeJournal({ ...journal, entries: journal.entries.filter((entry) => !isPending(entry)) });

execFileSync('npx', ['drizzle-kit', 'generate', '--name', `v${version}`], { cwd: root, stdio: 'inherit' });

const squashed = readJournal();
const latest = squashed.entries[squashed.entries.length - 1];
latest.when = when;
writeJournal(squashed);

console.log(`Squashed ${pending.length} migration(s) into ${latest.tag}.sql`);
