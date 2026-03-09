import chalk from 'chalk';
import type { TimelineItem, ClipItem, OverlayItem } from '../schemas/timeline-items.js';

const positionArrows: Record<string, string> = {
  'center': '─',
  'top-left': '↖',
  'top-right': '↗',
  'bottom-left': '↙',
  'bottom-center': '↓',
  'bottom-right': '↘',
};

interface OverlaySpan {
  startCol: number;
  endCol: number;
  style: string;
  position: string;
}

function padCenter(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function renderOverlayLabel(style: string, arrow: string, width: number): string {
  if (width < 2) return '';
  if (width === 2) return '‹›';
  if (width < 2 + arrow.length) return '‹›';
  if (width === 2 + arrow.length) return `‹${arrow}›`;

  // Full format: ‹{arrow} {style} {arrow}›
  const fullLength = 2 + arrow.length * 2 + style.length + 2;
  if (width >= fullLength) {
    const contentWidth = width - 2 - arrow.length * 2;
    const centered = padCenter(style, contentWidth);
    return `‹${arrow}${centered}${arrow}›`;
  }

  // Truncated: ‹{arrow} {truncatedText}›, padded to exact width
  const availForText = width - 2 - arrow.length;
  if (availForText >= 2) {
    let text = ' ' + style.slice(0, availForText - 1);
    if (text.length < availForText) {
      text += ' '.repeat(availForText - text.length);
    }
    return `‹${arrow}${text}›`;
  }

  // Pad to exact width
  const base = `‹${arrow}›`;
  return base + ' '.repeat(Math.max(0, width - base.length));
}

function colorOverlay(text: string): string {
  return chalk.yellow(text);
}

function renderLane(lane: OverlaySpan[], trackWidth: number): string {
  let result = '';
  let cursor = 0;

  for (const o of lane) {
    if (o.startCol > cursor) {
      result += ' '.repeat(o.startCol - cursor);
    }
    const w = o.endCol - o.startCol;
    const arrow = positionArrows[o.position] ?? '─';
    const label = renderOverlayLabel(o.style, arrow, w);
    result += colorOverlay(label);
    cursor = o.endCol;
  }

  if (cursor < trackWidth) {
    result += ' '.repeat(trackWidth - cursor);
  }

  return result;
}

export function renderTimeline(items: TimelineItem[], terminalWidth: number): string[] {
  const clips = items.filter((i): i is ClipItem => i.type === 'clip');
  if (clips.length === 0) return [];

  const overlays = items.filter((i): i is OverlayItem => i.type === 'overlay');

  const padding = 2;
  const trackWidth = terminalWidth - padding * 2;
  if (trackWidth < 8) return [];

  // Compute clip durations
  const clipDurations = clips.map(c =>
    (c.endTimeSeconds - c.startTimeSeconds) / c.playbackRate,
  );

  // Total duration accounting for transition overlaps
  let totalDuration = 0;
  for (let i = 0; i < clips.length; i++) {
    totalDuration += clipDurations[i];
    if (i > 0 && clips[i].transition) {
      totalDuration -= clips[i].transition!.durationSeconds;
    }
  }

  // Allocate clip character widths with error diffusion
  const minWidth = (i: number) => (i > 0 && clips[i].transition) ? 5 : 4;
  let error = 0;
  const clipWidths: number[] = [];

  for (let i = 0; i < clips.length; i++) {
    const raw = (clipDurations[i] / totalDuration) * trackWidth + error;
    const rounded = Math.max(minWidth(i), Math.round(raw));
    error = raw - rounded;
    clipWidths.push(rounded);
  }

  // Correct total width if needed
  const totalAllocated = clipWidths.reduce((a, b) => a + b, 0);
  if (totalAllocated !== trackWidth) {
    let widestIdx = 0;
    for (let i = 1; i < clipWidths.length; i++) {
      if (clipWidths[i] > clipWidths[widestIdx]) widestIdx = i;
    }
    clipWidths[widestIdx] += trackWidth - totalAllocated;
  }

  // Compute column positions for each clip
  const clipStartCol: number[] = [];
  const clipEndCol: number[] = [];
  let col = 0;
  for (let i = 0; i < clips.length; i++) {
    clipStartCol.push(col);
    col += clipWidths[i];
    clipEndCol.push(col);
  }

  // Summary line
  const totalSec = Math.round(totalDuration);
  const durStr = totalSec >= 60
    ? `${Math.floor(totalSec / 60)}m${totalSec % 60 > 0 ? ` ${totalSec % 60}s` : ''}`
    : `${totalSec}s`;
  let summary = `${durStr} | ${clips.length} clips`;
  if (overlays.length > 0) {
    summary += `, ${overlays.length} overlay${overlays.length > 1 ? 's' : ''}`;
  }

  // Map overlays to column spans
  const overlaySpans: OverlaySpan[] = [];
  for (const o of overlays) {
    const endClipIdx = o.endClip ?? o.startClip;
    if (o.startClip >= clips.length || endClipIdx >= clips.length) continue;
    // Skip past the `~` transition marker at clip boundaries
    let startCol = clipStartCol[o.startClip];
    if (o.startClip > 0 && clips[o.startClip].transition) {
      startCol += 1; // skip `~`
    }
    const endCol = clipEndCol[endClipIdx];
    overlaySpans.push({
      startCol,
      endCol,
      style: o.style,
      position: o.position,
    });
  }

  // Greedy lane assignment
  const sorted = [...overlaySpans].sort((a, b) => a.startCol - b.startCol);
  const lanes: OverlaySpan[][] = [];
  for (const span of sorted) {
    let placed = false;
    for (const lane of lanes) {
      if (lane[lane.length - 1].endCol <= span.startCol) {
        lane.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push([span]);
  }

  // Render clip track
  let clipTrack = '';
  for (let i = 0; i < clips.length; i++) {
    const w = clipWidths[i];
    const hasTransition = i > 0 && !!clips[i].transition;
    const prefix = hasTransition ? '~[' : '[';
    const suffix = ']';
    const innerWidth = w - prefix.length - suffix.length;
    const label = `v${clips[i].videoId}`;

    let inner: string;
    if (innerWidth >= label.length + 2) {
      inner = padCenter(label, innerWidth);
    } else {
      inner = ' '.repeat(Math.max(0, innerWidth));
    }
    clipTrack += prefix + inner + suffix;
  }

  // Assemble output
  const pad = ' '.repeat(padding);
  const lines: string[] = [];
  lines.push(pad + chalk.dim(summary));
  for (let i = lanes.length - 1; i >= 0; i--) {
    lines.push(pad + renderLane(lanes[i], trackWidth));
  }
  lines.push(pad + chalk.cyan(clipTrack));

  return lines;
}
