import { GoogleGenAI } from '@google/genai';

let client: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY environment variable is required.'
      );
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}
