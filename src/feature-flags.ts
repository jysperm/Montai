import type { ProjectConfig } from './schemas/project.js';

export interface FeatureFlags {
  music: boolean;
  musicGeneration: boolean;
  voiceover: boolean;
  voiceoverGeneration: boolean;
  previewTools: boolean;
  multiStory: boolean;
}

export interface FeatureFlagContext {
  hasMusic: boolean;
  hasVoiceovers: boolean;
}

export function resolveFeatureFlags(
  config: ProjectConfig,
  context: FeatureFlagContext,
): FeatureFlags {
  const features: FeatureFlags = {
    music: context.hasMusic || Boolean(config.models.musicGeneration),
    musicGeneration: Boolean(config.models.musicGeneration),
    voiceover: context.hasVoiceovers,
    voiceoverGeneration: Boolean(config.models.voiceoverGeneration),
    previewTools: true,
    multiStory: true,
    ...config.featureFlags,
  };

  // The `system` provider shells out to macOS's built-in `say`, so it only works on darwin.
  if (features.voiceoverGeneration && config.models.voiceoverGeneration === 'system' && process.platform !== 'darwin') {
    throw new Error('models.voiceoverGeneration: "system" requires macOS. Use "gemini-2.5-flash-preview-tts" on this platform.');
  }
  return features;
}
