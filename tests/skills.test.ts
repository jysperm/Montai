import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { FeatureFlags } from '../src/feature-flags.js';
import { activeSkills, discoverSkills, formatSkillInstruction, loadedSkillNames } from '../src/skills.js';

const features: FeatureFlags = {
  music: false,
  musicGeneration: false,
  voiceover: false,
  voiceoverGeneration: false,
  previewTools: true,
  multiStory: true,
};

function writeSkill(dir: string, filename: string, metadata: string, body = '') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, filename), `---\n${metadata}\n---\n${body}`);
}

describe('skills', () => {
  it('merges layers by name and keeps override information', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'montai-skills-'));
    const builtin = resolve(root, 'builtin');
    const user = resolve(root, 'user');
    const project = resolve(root, 'project');
    writeSkill(builtin, 'shared.md', 'description: Built in', 'builtin');
    writeSkill(user, 'shared.md', 'description: User copy', 'user');
    writeSkill(project, 'project-only.md', 'description: Project only');

    const skills = discoverSkills(features, { builtin, user, project });
    expect(activeSkills(skills).map((skill) => [skill.name, skill.source, skill.body])).toEqual([
      ['shared', 'user', 'user'],
      ['project-only', 'project', ''],
    ]);
    expect(skills.find((skill) => skill.source === 'builtin')?.overriddenBy?.source).toBe('user');
  });

  it('filters a winning skill when any gated feature is disabled', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'montai-skills-'));
    writeSkill(root, 'voice.md', 'description: Voice\ngatedBy: [voiceoverGeneration]');
    const skills = discoverSkills(features, { builtin: root, user: resolve(root, 'none-1'), project: resolve(root, 'none-2') });

    expect(activeSkills(skills)).toEqual([]);
    expect(skills[0].unavailableFlags).toEqual(['voiceoverGeneration']);
  });

  it('marks injected skill messages as loaded', () => {
    const skill = {
      name: 'framing', description: 'Framing', gatedBy: [], body: 'Instructions',
      path: '/skills/framing.md', source: 'builtin' as const,
    };
    const content = formatSkillInstruction(skill);
    expect(content).toContain('Skill "framing" loaded. Instructions:');
    expect(loadedSkillNames([{ role: 'user', content }])).toEqual(new Set(['framing']));
  });

  it('accepts relaxed names without whitespace or path separators and treats unknown gates as unavailable', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'montai-skills-'));
    writeSkill(root, 'Color-grading_HDR.v2.md', 'description: Specialized\ngatedBy: [futureFeature]');
    const skills = discoverSkills(features, { builtin: root, user: resolve(root, 'none-1'), project: resolve(root, 'none-2') });

    expect(skills[0].name).toBe('Color-grading_HDR.v2');
    expect(skills[0].unavailableFlags).toEqual(['futureFeature']);
    const instruction = formatSkillInstruction({ ...skills[0], body: 'Instructions' });
    expect(loadedSkillNames([{ role: 'user', content: instruction }])).toEqual(new Set(['Color-grading_HDR.v2']));
  });

  it.each(['two words', 'group\\name'])('rejects invalid skill filename %s', (name) => {
    const root = mkdtempSync(resolve(tmpdir(), 'montai-skills-'));
    writeSkill(root, `${name}.md`, 'description: Invalid');

    expect(() => discoverSkills(features, {
      builtin: root,
      user: resolve(root, 'none-1'),
      project: resolve(root, 'none-2'),
    })).toThrow(/without whitespace or path separators/);
  });

  it('uses the filename even when legacy frontmatter includes a name', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'montai-skills-'));
    writeSkill(root, 'filename-wins.md', 'name: ignored\ndescription: Filename wins');

    const skills = discoverSkills(features, {
      builtin: root,
      user: resolve(root, 'none-1'),
      project: resolve(root, 'none-2'),
    });
    expect(skills[0].name).toBe('filename-wins');
  });
});
