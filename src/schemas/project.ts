import { z } from 'zod';

const resolutionPresets = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
} as const;

export type ResolutionPreset = keyof typeof resolutionPresets;

export function resolveResolution(preset: ResolutionPreset) {
  return resolutionPresets[preset];
}

export const OutputSchema = z.object({
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).default('1080p'),
  fps: z.number().default(50),
});

export const ModelsSchema = z.object({
  analysis: z.string().default('gemini-3-flash-preview'),
  editing: z.string().default('gemini-3-pro-preview'),
});

export const EffectsSchema = z.object({
  languages: z.array(z.string()).default(['en']),
});

export const ProjectConfigSchema = z.object({
  videos: z.array(z.string()).min(1),
  intermediateLanguage: z.enum(['zh', 'en']).default('en'),
  output: OutputSchema.default(() => OutputSchema.parse({})),
  models: ModelsSchema.default(() => ModelsSchema.parse({})),
  effects: EffectsSchema.default(() => EffectsSchema.parse({})),
});

export type Output = z.infer<typeof OutputSchema>;
export type Models = z.infer<typeof ModelsSchema>;
export type Effects = z.infer<typeof EffectsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
