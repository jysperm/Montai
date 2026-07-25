import chalk from 'chalk';
import { resolveFeatureFlags } from '../feature-flags.js';
import { discoverSkills, type SkillSource } from '../skills.js';
import { loadProjectConfig, resolveMusicFiles, resolveVoiceoverFiles } from '../utils/project.js';

export async function skillsCommand() {
  const config = loadProjectConfig();
  const features = resolveFeatureFlags(config, {
    hasMusic: resolveMusicFiles(config).length > 0,
    hasVoiceovers: resolveVoiceoverFiles(config).length > 0,
  });
  const skills = discoverSkills(features);

  const groups: Array<{ source: SkillSource; label: string; emptyHint: string }> = [
    { source: 'builtin', label: 'Built-in', emptyHint: 'No built-in skills found.' },
    { source: 'user', label: 'User (~/.config/montai/skills)', emptyHint: 'Create .md files in ~/.config/montai/skills/' },
    { source: 'project', label: 'Project (./skills)', emptyHint: 'Create .md files in ./skills/' },
  ];

  for (const group of groups) {
    const groupSkills = skills.filter((skill) => skill.source === group.source);
    console.log(chalk.bold(group.label));
    if (groupSkills.length === 0) {
      console.log(chalk.dim(`  ${group.emptyHint}`));
      continue;
    }
    for (const skill of groupSkills) {
      let status: string;
      if (skill.overriddenBy) {
        status = chalk.dim(`overridden by ${skill.overriddenBy.source}`);
      } else if (skill.unavailableFlags.length > 0) {
        status = chalk.yellow(`unavailable: ${skill.unavailableFlags.join(', ')}`);
      } else {
        status = chalk.green('active');
      }
      console.log(`  ${chalk.cyan(skill.name)} — ${skill.description} (${status})`);
    }
  }

}
