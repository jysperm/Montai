import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { getDb } from '../db/index.js';
import { loadProjectConfig, loadExpandedTimelines } from '../utils/project.js';
import { preparePublicDir } from '../remotion/public-dir.js';
import { remapToArchived } from '../utils/archived-videos.js';
import { spawnInherit } from '../utils/spawn-inherit.js';

export async function previewCommand(name?: string, options?: { fromArchived?: boolean }) {
  const config = loadProjectConfig();
  const db = getDb();

  let specs = loadExpandedTimelines(db, config, name);
  if (!specs) return;

  if (options?.fromArchived) {
    specs = remapToArchived(specs);
  }

  // Prepare public dir with video hard links and timelines.json
  const publicDir = preparePublicDir(specs);

  // Resolve Remotion project path relative to this package
  const remotionProjectDir = fileURLToPath(
    new URL('../remotion/project', import.meta.url),
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
