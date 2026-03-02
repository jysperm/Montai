import chalk from 'chalk';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { timelines, stories } from '../db/schema.js';
import type { Timeline } from '../schemas/timeline.js';
import { preparePublicDir } from '../remotion/public-dir.js';

export async function studioCommand(name?: string) {
  const db = getDb();

  let specJson: string | undefined;
  if (name) {
    const timelineRow = db.select().from(timelines).where(eq(timelines.name, name)).get();
    if (timelineRow) {
      specJson = timelineRow.spec;
    } else {
      const storyRow = db.select().from(stories).where(eq(stories.name, name)).get();
      if (storyRow?.timeline) {
        specJson = storyRow.timeline;
      }
    }
  } else {
    const timelineRow = db.select().from(timelines).orderBy(desc(timelines.id)).get();
    if (timelineRow) {
      specJson = timelineRow.spec;
    } else {
      const storyRow = db.select({ timeline: stories.timeline })
        .from(stories)
        .where(sql`${stories.timeline} IS NOT NULL`)
        .orderBy(desc(stories.id))
        .get();
      if (storyRow?.timeline) {
        specJson = storyRow.timeline;
      }
    }
  }

  if (!specJson) {
    console.log(
      chalk.red(
        name
          ? `Timeline "${name}" not found. Run "montai edit" or "montai story" first.`
          : 'No timelines found. Run "montai edit" or "montai story" first.',
      ),
    );
    return;
  }

  const spec = JSON.parse(specJson) as Timeline;

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
