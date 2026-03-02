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
  storyline: loadTemplate('storyline'),
  editSystem: loadTemplate('edit-system'),
  editUser: loadTemplate('edit-user'),
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

function langName(language: string): string {
  return languageNames[language] ?? language;
}

export function videoAnalysisPrompt(intermediateLanguage: string, facts?: string | null): string {
  return templates.videoAnalysis({ languageName: langName(intermediateLanguage), facts: facts || null });
}

export function storylinePrompt(
  facts: string | null,
  videoSummaries: { videoId: number; summary: string }[],
  hint: string,
  intermediateLanguage: string,
): string {
  return templates.storyline({
    facts,
    videoSummaries,
    hint,
    languageName: langName(intermediateLanguage),
  });
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

export function timelineSystemPrompt(intermediateLanguage: string): string {
  return templates.editSystem({ languageName: langName(intermediateLanguage) });
}

export function timelineUserPrompt(
  storyline: string,
  videoSummaries: { videoId: number; filename: string; summary: string }[],
): string {
  return templates.editUser({ storyline, videoSummaries });
}

export function storySystemPrompt(intermediateLanguage: string): string {
  return templates.storySystem({ languageName: langName(intermediateLanguage) });
}

export function storyUserPrompt(
  videoSummaries: { videoId: number; filename: string; summary: string }[],
  facts: string | null,
  hint: string,
): string {
  return templates.storyUser({
    videoSummaries,
    facts: facts || null,
    hint: hint || null,
  });
}

export function storyResumePrompt(
  storyline: string,
  timelineItems: string | null,
  videoSummaries: { videoId: number; filename: string; summary: string }[],
): string {
  return templates.storyResume({
    storyline,
    timelineItems: timelineItems || null,
    videoSummaries,
  });
}
