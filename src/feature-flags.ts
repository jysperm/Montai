import type { ProjectConfig } from './schemas/project.js';

export interface FeatureFlags {
  music: boolean;
  musicGeneration: boolean;
  voiceover: boolean;
}

export interface FeatureFlagContext {
  hasMusic: boolean;
  hasVoiceovers: boolean;
}

export function resolveFeatureFlags(
  config: ProjectConfig,
  context: FeatureFlagContext,
): FeatureFlags {
  return {
    music: context.hasMusic || Boolean(config.models.musicGeneration),
    musicGeneration: Boolean(config.models.musicGeneration),
    voiceover: context.hasVoiceovers,
    ...config.featureFlags,
  };
}
