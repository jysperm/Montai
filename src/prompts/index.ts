import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = __dirname;

export const languageNames: Record<string, string> = {
  zh: 'Chinese',
  ja: 'Japanese',
  en: 'English',
};

Handlebars.registerHelper('langName', (language: string) => languageNames[language] ?? language);

Handlebars.registerHelper('overlayLanguageInstruction', (languages: string[]) => {
  const names = languages.map((l) => languageNames[l] ?? l);
  if (names.length === 1) {
    return `Write all overlay text (titles, captions, subtitles) in ${names[0]}.`;
  }
  return `Write all overlay text (titles, captions, subtitles) in ${names.join(' and ')}. Each overlay should include all languages.`;
});

// Load all .prompt files as both compiled templates and partials
const templates: Record<string, HandlebarsTemplateDelegate> = {};

for (const file of readdirSync(promptsDir)) {
  if (!file.endsWith('.prompt')) continue;
  const name = basename(file, '.prompt');
  const source = readFileSync(resolve(promptsDir, file), 'utf-8');
  templates[name] = Handlebars.compile(source, { noEscape: true });
  Handlebars.registerPartial(name, source);
}

export function renderPrompt(name: string, data: Record<string, unknown>): string {
  return templates[name](data);
}

export interface VideoAnalysisData {
  videoId: number;
  filename: string;
  duration?: string;
  overview: string;
  location?: string | null;
  timeOfDay?: string | null;
  segments: { startTime: string; endTime: string; description: string; qualityNotes?: string; speechContent?: string }[];
  highlights: { startTime: string; endTime: string; reason: string }[];
  technicalNotes?: string | null;
}

export interface MusicAnalysisData {
  musicId: number;
  filename: string;
  duration?: string;
  overview: string;
  segments: { startTime: string; endTime: string; description: string }[];
}

export interface VoiceoverAnalysisData {
  voiceoverId: number;
  filename: string;
  durationSeconds: number;
  duration?: string;
  overview: string;
  transcription: { startTime: string; endTime: string; text: string; skip?: boolean }[];
}
