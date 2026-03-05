import chalk from 'chalk';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { stories } from '../db/schema.js';
import type { Timeline } from '../schemas/timeline.js';
import { preparePublicDir } from '../remotion/public-dir.js';

export async function renderCommand(name?: string) {
  const db = getDb();

  let specJson: string | undefined;
  if (name) {
    const storyRow = db.select().from(stories).where(eq(stories.name, name)).get();
    if (storyRow?.timeline) {
      specJson = storyRow.timeline;
    }
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

  if (!specJson) {
    console.log(
      chalk.red(
        name
          ? `Timeline "${name}" not found. Run "montai story" first.`
          : 'No timelines found. Run "montai story" first.',
      ),
    );
    return;
  }

  const spec = JSON.parse(specJson) as Timeline;

  // Prepare public dir with video hard links
  const publicDir = preparePublicDir(spec);

  // Write spec for --props flag
  const specPath = resolve('.montai/specs', `${spec.name}.json`);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  // Resolve Remotion project path relative to this package
  const remotionProjectDir = fileURLToPath(
    new URL('../remotion/project', import.meta.url),
  );

  // Output to user's CWD
  const outputDir = resolve('output');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `${spec.name}.mp4`);

  console.log(chalk.blue(`Rendering "${spec.name}" via Remotion...`));
  console.log(chalk.cyan(`Output: ${outputPath}`));

  try {
    execSync(
      `npx remotion render src/index.tsx Montai "${outputPath}" --props="${specPath}" --public-dir="${publicDir}"`,
      {
        cwd: remotionProjectDir,
        stdio: 'inherit',
      },
    );
    console.log(chalk.green(`Render complete: ${outputPath}`));
  } catch {
    console.log(chalk.red(`Render failed for "${spec.name}".`));
  }
}
