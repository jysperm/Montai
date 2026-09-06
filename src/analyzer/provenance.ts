import { createHash } from 'crypto';
import { renderPrompt } from '../prompts/index.js';
import { readProjectFile } from '../utils/project.js';
import { montaiVersion } from '../utils/version.js';
import type { ProjectConfig } from '../schemas/project.js';
import type { AnalyzeKind } from './pipeline.js';

// What an analysis actually depended on. A stored row whose signature differs
// from the current one was produced under different conditions and is stale.
// `featureFlags.transcodeFps` is deliberately absent: analyze uploads the file
// but calls Gemini at its default 1fps sampling, so the transcode rate cannot
// change the result.
export interface AnalysisSignature {
  model: string;
  promptHash: string;
}

// How `montai analyze` picks what to run: nothing set analyzes only what has no
// analysis yet, `stale` adds rows whose signature no longer matches, `all` takes
// everything, and `file` takes one named file unconditionally.
export interface SyncOptions {
  file?: string;
  all?: boolean;
  stale?: AnalysisSignature;
}

// Written alongside every analysis: the signature plus when it ran and which
// build produced it. Version is recorded for traceability only — most releases
// don't touch analysis, so it would be far too eager a staleness trigger.
export interface AnalysisProvenance extends AnalysisSignature {
  analyzedAt: string;
  montaiVersion: string;
}

const promptNames: Record<AnalyzeKind, string> = {
  video: 'analyze-video',
  music: 'analyze-music',
  voiceover: 'analyze-voiceover',
};

// Hashes the rendered prompt, not the template, so a change to `language` or to
// the project's AGENTS.md counts as much as an edit to the template itself. The
// JSON structure the model must return lives in the prompt too, so a schema
// change is covered as long as the prompt describes it.
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

export function renderAnalysisPrompt(config: ProjectConfig, kind: AnalyzeKind): string {
  const agentInstructions = readProjectFile('AGENTS.md');
  return renderPrompt(promptNames[kind], { language: config.language, agentInstructions: agentInstructions ?? null });
}

export function analysisSignature(config: ProjectConfig, kind: AnalyzeKind, model: string): AnalysisSignature {
  return { model, promptHash: hashPrompt(renderAnalysisPrompt(config, kind)) };
}

export function provenanceFor(signature: AnalysisSignature): AnalysisProvenance {
  return { ...signature, analyzedAt: new Date().toISOString(), montaiVersion: montaiVersion() };
}

// A row is stale when it was produced under a different model or a different
// rendered prompt. Rows predating these columns read as NULL and count as stale.
export function isStale(row: { model: string | null; promptHash: string | null }, signature: AnalysisSignature): boolean {
  return row.model !== signature.model || row.promptHash !== signature.promptHash;
}
