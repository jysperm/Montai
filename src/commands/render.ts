import chalk from 'chalk';
import { mkdirSync, writeFileSync } from 'fs';
import { cpus } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/index.js';
import { loadProjectConfig, loadExpandedTimelines } from '../utils/project.js';
import { preparePublicDir } from '../remotion/public-dir.js';
import { remapToArchived } from '../utils/archived-videos.js';
import { spawnInherit } from '../utils/spawn-inherit.js';

export async function renderCommand(name?: string, options?: { fromArchived?: boolean }) {
  const config = loadProjectConfig();
  const db = getDb();

  let { timelines: specs } = loadExpandedTimelines(db, config, name);
  if (specs.length === 0) return;

  if (options?.fromArchived) {
    specs = remapToArchived(specs);
  }

  // Resolve Remotion project path relative to this package
  const remotionProjectDir = fileURLToPath(
    new URL('../../remotion', import.meta.url),
  );

  // Prepare public dir with video hard links for all specs
  const publicDir = preparePublicDir(specs);

  const outputDir = resolve('output');
  mkdirSync(outputDir, { recursive: true });

  for (const spec of specs) {
    // Write spec for --props flag
    const specPath = resolve('.montai/specs', `${spec.name}.json`);
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    const outputPath = resolve(outputDir, `${spec.name}.mp4`);

    console.log(chalk.blue(`Rendering "${spec.name}" via Remotion...`));
    console.log(chalk.cyan(`Output: ${outputPath}`));

    try {
      const code = await spawnInherit(
        'npx',
        [
          'remotion', 'render', 'src/index.tsx', spec.name, outputPath,
          `--props=${specPath}`,
          `--public-dir=${publicDir}`,
          `--concurrency=${Math.max(1, cpus().length - 1)}`,
        ],
        { cwd: remotionProjectDir },
      );
      if (code === 0) {
        console.log(chalk.green(`Render complete: ${outputPath}`));
      } else {
        console.log(chalk.red(`Render failed for "${spec.name}".`));
      }
    } catch {
      console.log(chalk.red(`Render failed for "${spec.name}".`));
    }
  }
}
