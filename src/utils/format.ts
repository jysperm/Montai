import chalk from 'chalk';
import { timeToSeconds } from './time.js';

/**
 * Format seconds into a human-readable duration string.
 * Examples: "15s", "3m12s", "3m", "1h30m", "1h30m15s"
 */
export function formatDuration(seconds: number): string {
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return s > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Format an ISO timestamp as relative time (e.g., "3 hours ago", "just now").
 */
export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days !== 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Format bytes into a human-readable size string (1024-based).
 * Examples: "512 B", "1.5 KB", "23.4 MB", "1.2 GB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Compute the total playback duration (in seconds) of a raw timeline items array.
 */
export function computeTimelineDuration(items: Array<Record<string, unknown>>): number {
  const clips = items.filter(i => i.type === 'clip');
  let total = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const startTime = typeof c.startTime === 'string'
      ? timeToSeconds(c.startTime)
      : (c.startTimeSeconds as number);
    const endTime = typeof c.endTime === 'string'
      ? timeToSeconds(c.endTime)
      : (c.endTimeSeconds as number);
    const dur = (endTime - startTime) / ((c.playbackRate as number) || 1);
    total += dur;
    if (i > 0 && c.transition) {
      total -= (c.transition as { durationSeconds: number }).durationSeconds;
    }
  }
  return total;
}

export function countItemsByType(items: Array<{ type: string }>): { clips: number; overlays: number; music: number; voiceover: number } {
  return {
    clips: items.filter(i => i.type === 'clip').length,
    overlays: items.filter(i => i.type === 'overlay').length,
    music: items.filter(i => i.type === 'music').length,
    voiceover: items.filter(i => i.type === 'voiceover').length,
  };
}

export function formatItemCountParts(counts: { clips: number; overlays: number; music: number; voiceover: number }): string[] {
  const parts: string[] = [];
  if (counts.clips > 0) parts.push(`${counts.clips} clip${counts.clips !== 1 ? 's' : ''}`);
  if (counts.overlays > 0) parts.push(`${counts.overlays} overlay${counts.overlays !== 1 ? 's' : ''}`);
  if (counts.music > 0) parts.push(`${counts.music} music`);
  if (counts.voiceover > 0) parts.push(`${counts.voiceover} voiceover`);
  return parts;
}

export function formatItemCounts(counts: { clips: number; overlays: number; music: number; voiceover: number }): string {
  return formatItemCountParts(counts).join(', ') || 'nothing';
}

/**
 * Format a mark row for display. Returns a single line string.
 */
export function formatMarkLine(m: { name: string; timeline: string; createdAt: string }): string {
  const items = JSON.parse(m.timeline) as Array<Record<string, unknown>>;
  const duration = computeTimelineDuration(items);
  const parts = formatItemCountParts(countItemsByType(items as Array<{ type: string }>));
  const status = [chalk.green(formatDuration(duration)), ...parts.map(p => chalk.green(p))].join(', ') || 'empty';
  const ago = formatTimeAgo(m.createdAt);
  return `${chalk.cyan(m.name)}  [${status}]  ${chalk.dim(ago)}`;
}

/**
 * Format a story row for display. Returns a single line string.
 */
export function formatStoryLine(s: { name: string; title: string; timeline: string | null; updatedAt: string }, options?: { indent?: boolean }): string {
  const indent = options?.indent ? '  ' : '';
  let status: string;
  if (s.timeline) {
    const items = JSON.parse(s.timeline) as Array<Record<string, unknown>>;
    const duration = computeTimelineDuration(items);
    const parts = formatItemCountParts(countItemsByType(items as Array<{ type: string }>));
    status = [chalk.green(formatDuration(duration)), ...parts.map(p => chalk.green(p))].join(', ') || 'nothing';
  } else {
    status = chalk.dim('empty');
  }
  const ago = formatTimeAgo(s.updatedAt);
  return `${indent}${chalk.cyan(s.name)}  ${s.title}  [${status}]  ${chalk.dim(ago)}`;
}
