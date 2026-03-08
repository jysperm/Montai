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
  mergeFacts: loadTemplate('merge-facts'),
  projectOverview: loadTemplate('project-overview'),
  storySystem: loadTemplate('story-system'),
  storyUser: loadTemplate('story-user'),
  storyResume: loadTemplate('story-resume'),
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

export function videoAnalysisPrompt(intermediateLanguage: string, facts?: string | null, agentInstructions?: string | null): string {
  return templates.videoAnalysis({ languageName: langName(intermediateLanguage), facts: facts || null, agentInstructions: agentInstructions || null });
}

export function mergeFactsPrompt(existingFacts: string | null, newFact: string, intermediateLanguage: string): string {
  return templates.mergeFacts({
    existingFacts: existingFacts || null,
    newFact,
    languageName: langName(intermediateLanguage),
  });
}

export function projectOverviewPrompt(
  facts: string | null,
  videoSummaries: { videoId: number; filename: string; overview: string; location: string | null; timeOfDay: string | null }[],
  intermediateLanguage: string,
): string {
  return templates.projectOverview({
    facts: facts || null,
    videoSummaries,
    languageName: langName(intermediateLanguage),
  });
}

export function storySystemPrompt(intermediateLanguage: string, overlayLanguages: string[], agentInstructions?: string | null): string {
  return templates.storySystem({
    languageName: langName(intermediateLanguage),
    overlayLanguageInstruction: formatOverlayLanguageInstruction(overlayLanguages),
    agentInstructions: agentInstructions || null,
  });
}

export function storyUserPrompt(
  videoSummaries: { videoId: number; filename: string; summary: string }[],
  facts: string | null,
  hint: string,
  styleReference?: string | null,
): string {
  return templates.storyUser({
    videoSummaries,
    facts: facts || null,
    hint: hint || null,
    styleReference: styleReference || null,
  });
}

export function storyResumePrompt(
  storyline: string,
  timelineItems: string | null,
  videoSummaries: { videoId: number; filename: string; summary: string }[],
  facts: string | null,
  styleReference?: string | null,
): string {
  return templates.storyResume({
    storyline,
    timelineItems: timelineItems || null,
    videoSummaries,
    facts: facts || null,
    styleReference: styleReference || null,
  });
}
