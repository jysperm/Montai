import { z } from 'zod';

export const resolutionPresets = {
  // Landscape 16:9
  '720p':  { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
  '4k':    { width: 3840, height: 2160 },
  // Vertical 9:16
  '720v':  { width: 720,  height: 1280 },
  '1080v': { width: 1080, height: 1920 },
  '1440v': { width: 1440, height: 2560 },
  // Square 1:1
  '720s':  { width: 720,  height: 720 },
  '1080s': { width: 1080, height: 1080 },
  '1440s': { width: 1440, height: 1440 },
} as const;

const RESOLUTION_PRESET_NAMES = Object.keys(resolutionPresets) as [ResolutionPreset, ...ResolutionPreset[]];

export type ResolutionPreset = keyof typeof resolutionPresets;
export type SequenceShape = 'landscape' | 'vertical' | 'square';
export type Assets = z.infer<typeof AssetsSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type Models = z.infer<typeof ModelsSchema>;
export type Effects = z.infer<typeof EffectsSchema>;
export type FeatureFlagsOverride = z.infer<typeof FeatureFlagsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const OutputSchema = z.object({
  resolution: z.enum(RESOLUTION_PRESET_NAMES).default('1080p'),
  fps: z.number().default(50),
});

export const ModelsSchema = z.object({
  analysis: z.string().default('gemini-3.5-flash'),
  editing: z.string().default('gemini-3.5-flash'),
  musicGeneration: z.enum(['lyria-002']).optional(),
  voiceoverGeneration: z.enum(['gemini-2.5-flash-tts', 'system']).optional(),
});

export const EffectsSchema = z.object({
  languages: z.array(z.string()).default(['en']),
  // Spoken language for AI-generated (TTS) voiceover narration. Distinct from
  // `language` (internal LLM text) and `languages` (overlay text). Falls back to
  // the first `languages` entry (then `language`) when unset.
  voiceLanguage: z.string().optional(),
});

export const FeatureFlagsSchema = z.object({
  music: z.boolean().optional(),
  musicGeneration: z.boolean().optional(),
  voiceover: z.boolean().optional(),
  voiceoverGeneration: z.boolean().optional(),
  previewTools: z.boolean().optional(),
  // FPS the analyze pipeline transcodes source videos at. The analyze step
  // itself still calls Gemini at default (1fps) sampling — bumping this only
  // pre-warms the transcode cache so subsequent watchSegment calls at the
  // same fps don't have to re-transcode.
  transcodeFps: z.number().min(1).optional(),
  // Per-stage concurrency for the analyze pipeline. transcode defaults to
  // CPU/4 (min 2); upload and analyze default to 2.
  transcodeConcurrency: z.number().min(1).optional(),
  uploadConcurrency: z.number().min(1).optional(),
  analyzeConcurrency: z.number().min(1).optional(),
}).default({});

export const AssetsSchema = z.object({
  videos: PathListSchema(z.array(z.string()).min(1)),
  music: PathListSchema(z.array(z.string()).default([])),
  voiceover: PathListSchema(z.array(z.string()).default([])),
});

export const ProjectConfigSchema = z.preprocess(
  (raw: unknown) => {
    // Backward compat: top-level `videos` → `assets.videos`
    if (raw && typeof raw === 'object' && 'videos' in raw && !('assets' in raw)) {
      const { videos, ...rest } = raw as Record<string, unknown>;
      return { ...rest, assets: { videos } };
    }
    return raw;
  },
  z.object({
    assets: AssetsSchema,
    language: z.enum(['zh', 'en']).default('en'),
    output: OutputSchema.default(() => OutputSchema.parse({})),
    models: ModelsSchema.default(() => ModelsSchema.parse({})),
    effects: EffectsSchema.default(() => EffectsSchema.parse({})),
    featureFlags: FeatureFlagsSchema,
  }),
);

export function resolveResolution(preset: ResolutionPreset) {
  return resolutionPresets[preset];
}

// Spoken language for AI-generated (TTS) voiceover: the dedicated
// `effects.voiceLanguage`, else the first overlay language, else internal `language`.
export function resolveVoiceLanguage(config: ProjectConfig): string {
  return config.effects.voiceLanguage ?? config.effects.languages[0] ?? config.language;
}

export function sequenceShape(width: number, height: number): SequenceShape {
  if (width > height) return 'landscape';
  if (height > width) return 'vertical';
  return 'square';
}

function PathListSchema(schema: z.ZodType<string[]>) {
  return z.preprocess(
    (value) => typeof value === 'string' ? [value] : value,
    schema,
  );
}
