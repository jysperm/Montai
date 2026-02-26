import chalk from 'chalk';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { editSpecs } from '../db/schema.js';
import type { EditSpec } from '../schemas/edit-spec.js';
import { preparePublicDir } from '../remotion/public-dir.js';

export async function studioCommand(name?: string) {
  const db = getDb();

  let specRow;
  if (name) {
    specRow = db.select().from(editSpecs).where(eq(editSpecs.name, name)).get();
  } else {
    specRow = db.select().from(editSpecs).orderBy(desc(editSpecs.id)).get();
  }

  if (!specRow) {
    console.log(
      chalk.red(
        name
          ? `Edit spec "${name}" not found. Run "cutflow edit" first.`
          : 'No edit specs found. Run "cutflow edit" first.',
      ),
    );
    return;
  }

  const spec = JSON.parse(specRow.spec) as EditSpec;

  // Prepare public dir with video hard links and editSpec.json
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
