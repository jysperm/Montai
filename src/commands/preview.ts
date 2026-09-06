import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { initDb } from '../db/index.js';
import { loadProjectConfig, loadResolvedTimelines } from '../utils/project.js';
import { preparePublicDir } from '../remotion/public-dir.js';
import { remapToArchived } from '../utils/archived-videos.js';
import { spawnInherit } from '../utils/spawn-inherit.js';

export async function previewCommand(name?: string, options?: { fromArchived?: boolean }) {
  const config = loadProjectConfig();
  const db = await initDb();

  let { timelines: specs } = loadResolvedTimelines(db, config, name);
  if (specs.length === 0) return;

  if (options?.fromArchived) {
    specs = remapToArchived(specs);
  }

  let publicDir: string;
  try {
    publicDir = preparePublicDir(specs);
  } catch (err) {
    console.log(chalk.red(err instanceof Error ? err.message : String(err)));
    console.log(`The stored timeline may contain outdated paths. Try re-running ${chalk.bold('montai story')} to regenerate the timeline.`);
    process.exit(1);
  }

  // Resolve Remotion project path relative to this package
  const remotionProjectDir = fileURLToPath(
    new URL('../../remotion', import.meta.url),
  );

  console.log(chalk.blue(
    specs.length === 1
      ? `Opening Remotion Studio for "${specs[0].name}"...`
      : `Opening Remotion Studio with ${specs.length} stories...`,
  ));

  try {
    await spawnInherit('npx', ['remotion', 'studio', 'src/index.tsx', `--public-dir=${publicDir}`], {
      cwd: remotionProjectDir,
    });
  } catch {
    console.log(chalk.red('Failed to start Remotion Studio.'));
  }
}
