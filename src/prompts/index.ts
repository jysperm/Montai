import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = __dirname;

function loadTemplate(name: string): HandlebarsTemplateDelegate {
  const source = readFileSync(resolve(promptsDir, `${name}.prompt`), 'utf-8');
  return Handlebars.compile(source, { noEscape: true });
}

const templates = {
  videoAnalysis: loadTemplate('video-analysis'),
  musicAnalysis: loadTemplate('music-analysis'),
  mergeFacts: loadTemplate('merge-facts'),
  projectOverview: loadTemplate('project-overview'),
  storySystem: loadTemplate('story-system'),
  storyContext: loadTemplate('story-context'),
};

const languageNames: Record<string, string> = {
  zh: 'Chinese',
  ja: 'Japanese',
  en: 'English',
};

export function langName(language: string): string {
  return languageNames[language] ?? language;
}

function formatOverlayLanguageInstruction(languages: string[]): string {
  const names = languages.map(langName);
  if (names.length === 1) {
    return `Write all overlay text (titles, captions, subtitles) in ${names[0]}.`;
  }
  return `Write all overlay text (titles, captions, subtitles) in ${names.join(' and ')}. Each overlay should include all languages.`;
}

export function videoAnalysisPrompt(language: string, facts?: string | null, agentInstructions?: string | null): string {
  return templates.videoAnalysis({ languageName: langName(language), facts: facts || null, agentInstructions: agentInstructions || null });
}

export function musicAnalysisPrompt(language: string, agentInstructions?: string | null): string {
  return templates.musicAnalysis({ languageName: langName(language), agentInstructions: agentInstructions || null });
}

export function mergeFactsPrompt(existingFacts: string | null, newFact: string, language: string): string {
  return templates.mergeFacts({
    existingFacts: existingFacts || null,
    newFact,
    languageName: langName(language),
  });
}

export function projectOverviewPrompt(
  facts: string | null,
  videoSummaries: { videoId: number; filename: string; overview: string; location: string | null; timeOfDay: string | null }[],
  language: string,
): string {
  return templates.projectOverview({
    facts: facts || null,
    videoSummaries,
    languageName: langName(language),
  });
}

export function storySystemPrompt(language: string, overlayLanguages: string[], agentInstructions?: string | null): string {
  return templates.storySystem({
    languageName: langName(language),
    overlayLanguageInstruction: formatOverlayLanguageInstruction(overlayLanguages),
    agentInstructions: agentInstructions || null,
  });
}

export function storyContextPrompt(
  videoSummaries: { videoId: number; filename: string; summary: string }[],
  facts: string | null,
  options?: {
    storyline?: string;
    timelineItems?: string | null;
    styleReference?: string | null;
    musicSummaries?: { musicId: number; filename: string; summary: string }[];
  },
): string {
  const opts = options ?? {};
  return templates.storyContext({
    videoSummaries,
    facts: facts || null,
    storyline: opts.storyline || null,
    timelineItems: opts.timelineItems || null,
    styleReference: opts.styleReference || null,
    musicSummaries: opts.musicSummaries && opts.musicSummaries.length > 0 ? opts.musicSummaries : null,
  });
}
