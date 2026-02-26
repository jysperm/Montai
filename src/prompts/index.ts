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
  projectSummaryInitial: loadTemplate('project-summary-initial'),
  projectSummaryUpdate: loadTemplate('project-summary-update'),
  storyline: loadTemplate('storyline'),
  editSystem: loadTemplate('edit-system'),
  editUser: loadTemplate('edit-user'),
};

const languageNames: Record<string, string> = {
  zh: 'Chinese',
  ja: 'Japanese',
  en: 'English',
};

function langName(language: string): string {
  return languageNames[language] ?? language;
}

export function videoAnalysisPrompt(intermediateLanguage: string, projectSummary?: string | null): string {
  return templates.videoAnalysis({ languageName: langName(intermediateLanguage), projectSummary: projectSummary || null });
}

export function projectSummaryPrompt(
  existingSummary: string | null,
  videoId: number,
  intermediateLanguage: string,
): string {
  const languageName = langName(intermediateLanguage);
  if (!existingSummary) {
    return templates.projectSummaryInitial({ videoId, languageName });
  }
  return templates.projectSummaryUpdate({ existingSummary, videoId, languageName });
}

export function storylinePrompt(
  projectSummary: string,
  videoSummaries: { videoId: number; summary: string }[],
  hint: string,
  intermediateLanguage: string,
): string {
  return templates.storyline({
    projectSummary,
    videoSummaries,
    hint,
    languageName: langName(intermediateLanguage),
  });
}

export function editSpecSystemPrompt(intermediateLanguage: string): string {
  return templates.editSystem({ languageName: langName(intermediateLanguage) });
}

export function editSpecUserPrompt(
  storyline: string,
  videoSummaries: { videoId: number; filename: string; summary: string }[],
): string {
  return templates.editUser({ storyline, videoSummaries });
}
