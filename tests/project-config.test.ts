import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../src/schemas/project.js';

describe('ProjectConfigSchema', () => {
  it.each(['en', 'zh', 'ja', 'fr'])('accepts ISO 639-1 language code %s', (language) => {
    const config = ProjectConfigSchema.parse({
      assets: { videos: ['.'] },
      language,
    });

    expect(config.language).toBe(language);
  });

  it.each(['', 'english', 'zh-CN'])('rejects non-ISO-639-1 language value %s', (language) => {
    expect(() => ProjectConfigSchema.parse({
      assets: { videos: ['.'] },
      language,
    })).toThrow(/ISO 639-1/);
  });
});
