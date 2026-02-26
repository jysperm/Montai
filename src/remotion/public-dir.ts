import { mkdirSync, linkSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { EditSpec } from '../schemas/edit-spec.js';

export function preparePublicDir(spec: EditSpec): string {
  const publicDir = resolve('.cutflow/public');
  mkdirSync(publicDir, { recursive: true });

  const seen = new Set<string>();

  for (const clip of spec.clips) {
    const filename = basename(clip.sourceFile);
    if (seen.has(filename)) continue;
    seen.add(filename);

    const linkPath = resolve(publicDir, filename);
    const absoluteSource = resolve(clip.sourceFile);

    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
    }

    linkSync(absoluteSource, linkPath);
  }

  // Write editSpec.json for studio fallback
  writeFileSync(
    resolve(publicDir, 'editSpec.json'),
    JSON.stringify(spec, null, 2),
  );

  return publicDir;
}
