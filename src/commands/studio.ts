import chalk from 'chalk';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { timelines } from '../db/schema.js';
import type { Timeline } from '../schemas/timeline.js';
import { preparePublicDir } from '../remotion/public-dir.js';

export async function studioCommand(name?: string) {
  const db = getDb();

  let specRow;
  if (name) {
    specRow = db.select().from(timelines).where(eq(timelines.name, name)).get();
  } else {
    specRow = db.select().from(timelines).orderBy(desc(timelines.id)).get();
  }

  if (!specRow) {
    console.log(
      chalk.red(
        name
          ? `Timeline "${name}" not found. Run "cutflow edit" first.`
          : 'No timelines found. Run "cutflow edit" first.',
      ),
    );
    return;
  }

  const spec = JSON.parse(specRow.spec) as Timeline;

  // Prepare public dir with video hard links and timeline.json
  const publicDir = preparePublicDir(spec);

  // Resolve Remotion project path relative to this package
  const remotionProjectDir = fileURLToPath(
    new URL('../remotion/project', import.meta.url),
  );

  console.log(chalk.blue(`Opening Remotion Studio for "${spec.name}"...`));

  try {
    execSync(`npx remotion studio src/index.tsx --public-dir="${publicDir}"`, {
      cwd: remotionProjectDir,
      stdio: 'inherit',
    });
  } catch {
    console.log(chalk.red('Failed to start Remotion Studio.'));
  }
}
