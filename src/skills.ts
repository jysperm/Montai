import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { FeatureFlags } from './feature-flags.js';

export type SkillSource = 'builtin' | 'user' | 'project';

export interface Skill {
  name: string;
  description: string;
  gatedBy: string[];
  unlockTools: string[];
  body: string;
  path: string;
  source: SkillSource;
}

export interface DiscoveredSkill extends Skill {
  active: boolean;
  overriddenBy?: Skill;
  unavailableFlags: string[];
}

export interface SkillDirectories {
  builtin?: string;
  user?: string;
  project?: string;
}

export function defaultSkillDirectories(projectDir = process.cwd()): Required<SkillDirectories> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return {
    builtin: resolve(moduleDir, '..', 'skills'),
    user: resolve(homedir(), '.config', 'montai', 'skills'),
    project: resolve(projectDir, 'skills'),
  };
}

function parseSkill(path: string, source: SkillSource): Skill {
  const raw = readFileSync(path, 'utf-8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`Skill ${path} must start with YAML frontmatter enclosed by --- lines.`);

  const metadata = parseYaml(match[1]) as Record<string, unknown> | null;
  const name = basename(path, '.md');
  const description = metadata?.description;
  const gatedBy = metadata?.gatedBy ?? [];
  const unlockTools = metadata?.unlockTools ?? [];

  if (!name || /[\s/\\]/.test(name)) {
    throw new Error(`Skill ${path} must have a non-empty name without whitespace or path separators.`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`Skill ${path} must have a non-empty description.`);
  }
  if (!Array.isArray(gatedBy) || gatedBy.some((flag) => typeof flag !== 'string')) {
    throw new Error(`Skill ${path} gatedBy must be an array of strings.`);
  }
  if (!Array.isArray(unlockTools) || unlockTools.some((tool) => typeof tool !== 'string')) {
    throw new Error(`Skill ${path} unlockTools must be an array of strings.`);
  }

  return {
    name,
    description: description.trim().replace(/\s+/g, ' '),
    gatedBy,
    unlockTools,
    body: match[2].trim(),
    path,
    source,
  };
}

function readSkillDirectory(path: string, source: SkillSource): Skill[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseSkill(resolve(path, entry.name), source));
}

export function discoverSkills(
  features: FeatureFlags,
  directories: SkillDirectories = {},
): DiscoveredSkill[] {
  const defaults = defaultSkillDirectories();
  const layers = [
    { source: 'builtin' as const, path: directories.builtin ?? defaults.builtin },
    { source: 'user' as const, path: directories.user ?? defaults.user },
    { source: 'project' as const, path: directories.project ?? defaults.project },
  ];
  const all = layers.flatMap(({ source, path }) => readSkillDirectory(path, source));
  const winnerByName = new Map<string, Skill>();
  for (const skill of all) winnerByName.set(skill.name, skill);

  return all.map((skill) => {
    const winner = winnerByName.get(skill.name)!;
    const unavailableFlags = skill.gatedBy.filter(
      (flag) => !Boolean((features as unknown as Record<string, unknown>)[flag]),
    );
    return {
      ...skill,
      active: skill === winner && unavailableFlags.length === 0,
      overriddenBy: skill === winner ? undefined : winner,
      unavailableFlags,
    };
  });
}

export function activeSkills(skills: DiscoveredSkill[]): Skill[] {
  return skills.filter((skill) => skill.active);
}

export function formatSkillInstruction(skill: Skill): string {
  return `Skill ${JSON.stringify(skill.name)} loaded. Instructions:\n\n${skill.body}`;
}

export function loadedSkillNames(messages: Array<{ role: string; content: unknown }>): Set<string> {
  const loaded = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    const match = message.content.match(/^Skill ("(?:[^"\\]|\\.)*") loaded\. Instructions:\n\n/);
    if (!match) continue;
    try {
      const name = JSON.parse(match[1]);
      if (typeof name === 'string') loaded.add(name);
    } catch {
      // Ignore malformed messages that merely resemble a skill instruction.
    }
  }
  return loaded;
}
