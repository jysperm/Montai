import type { Model } from '@mariozechner/pi-ai';

type GeminiApi = 'google-generative-ai';

// pi-ai ships its own model registry, but it trails Google's releases by months
// (0.73.1 still stops at Gemini 3.1), so the models Montai accepts live here
// instead of in a patch against `models.generated.js`. Costs are USD per 1M tokens
// at standard-tier list price, ignoring promotional and batch discounts.
export const GEMINI_MODELS: Record<string, Model<GeminiApi>> = {
  'gemini-3.8-flash': geminiModel('gemini-3.8-flash', 'Gemini 3.8 Flash', { input: 1.5, output: 7.5, cacheRead: 0.15 }),
  'gemini-3.5-flash': geminiModel('gemini-3.5-flash', 'Gemini 3.5 Flash', { input: 1.5, output: 9, cacheRead: 0.15 }),
  'gemini-3-flash-preview': geminiModel('gemini-3-flash-preview', 'Gemini 3 Flash Preview', { input: 0.5, output: 3, cacheRead: 0.05 }),
  'gemini-3.1-pro-preview': geminiModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', { input: 2, output: 12, cacheRead: 0.2 }),
};

export function getGeminiModel(id: string): Model<GeminiApi> {
  const model = GEMINI_MODELS[id];
  if (!model) {
    throw new Error(`Unknown model '${id}'. Supported models: ${Object.keys(GEMINI_MODELS).join(', ')}.`);
  }
  return model;
}

function geminiModel(id: string, name: string, cost: Omit<Model<GeminiApi>['cost'], 'cacheWrite'>): Model<GeminiApi> {
  return {
    id,
    name,
    api: 'google-generative-ai',
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: true,
    input: ['text', 'image'],
    cost: { ...cost, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };
}
