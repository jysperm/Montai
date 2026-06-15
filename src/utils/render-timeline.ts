import chalk from 'chalk';
import { sourceFileStartSeconds, sourceFileEndSeconds, computeClipTimings, clipAnchoredStart, clipAnchoredEnd } from '../schemas/timeline/clip-utils.js';
import type { TimelineItem, ClipItem, OverlayItem, MusicItem, VoiceoverItem } from '../schemas/timeline.js';

export const GENERATED_MUSIC_PROMPT_PREVIEW_LENGTH = 40;

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

function renderClipInner(label: string, width: number): string {
  if (width <= 0) return '';
  if (width >= label.length) return padCenter(label, width);
  return label.slice(0, width);
}

export function formatGeneratedMusicPrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, ' ');
  if (normalized.length <= GENERATED_MUSIC_PROMPT_PREVIEW_LENGTH) return normalized;

  let end = normalized.indexOf(' ', GENERATED_MUSIC_PROMPT_PREVIEW_LENGTH);
  if (end === -1) return normalized;
  while (end > 0 && normalized[end - 1] === ' ') end--;
  return normalized.slice(0, end) + '...';
}

function renderOverlayLabel(style: string, arrow: string, width: number, rightArrow?: string): string {
  const rArrow = rightArrow ?? arrow;
  if (width < 2) return '';
  if (width === 2) return '‹›';
  if (width < 2 + arrow.length) return '‹›';
  if (width === 2 + arrow.length) return `‹${arrow}›`;

  // Full format: ‹{arrow} {style} {rArrow}›
  const fullLength = 2 + arrow.length + rArrow.length + style.length + 2;
  if (width >= fullLength) {
    const contentWidth = width - 2 - arrow.length - rArrow.length;
    const centered = padCenter(style, contentWidth);
    return `‹${arrow}${centered}${rArrow}›`;
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

interface AudioSpan {
  startCol: number;
  endCol: number;
  label: string;
}

function colorOverlay(text: string): string {
  return chalk.magenta(text);
}

function colorAudio(text: string): string {
  return chalk.green(text);
}

function colorVoiceover(text: string): string {
  return chalk.yellow(text);
}

function renderAudioLane(lane: AudioSpan[], trackWidth: number): string {
  let result = '';
  let cursor = 0;

  for (const a of lane) {
    if (a.startCol > cursor) {
      result += ' '.repeat(a.startCol - cursor);
    }
    const w = a.endCol - a.startCol;
    const label = renderOverlayLabel(a.label, '♫', w);
    result += colorAudio(label);
    cursor = a.endCol;
  }

  if (cursor < trackWidth) {
    result += ' '.repeat(trackWidth - cursor);
  }

  return result;
}

function renderVoiceoverLane(lane: AudioSpan[], trackWidth: number): string {
  let result = '';
  let cursor = 0;

  for (const a of lane) {
    if (a.startCol > cursor) {
      result += ' '.repeat(a.startCol - cursor);
    }
    const w = a.endCol - a.startCol;
    const label = renderOverlayLabel(a.label, '‣', w, '');
    result += colorVoiceover(label);
    cursor = a.endCol;
  }

  if (cursor < trackWidth) {
    result += ' '.repeat(trackWidth - cursor);
  }

  return result;
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

export function renderTimeline(items: TimelineItem[], terminalWidth: number, musicNames?: Map<number, string>, storyName?: string): string[] {
  const clips = items.filter((i): i is ClipItem => i.type === 'clip');
  if (clips.length === 0) return [];

  const overlays = items.filter((i): i is OverlayItem => i.type === 'overlay');
  const audios = items.filter((i): i is MusicItem => i.type === 'music');
  const voiceoversItems = items.filter((i): i is VoiceoverItem => i.type === 'voiceover');

  const padding = 2;
  const trackWidth = terminalWidth - padding * 2;
  if (trackWidth < 8) return [];

  const timings = computeClipTimings(clips);
  const clipDurations = timings.durations;
  const totalDuration = timings.total;

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

  const clipStartTimes = timings.startTimes;

  // Map absolute time to column, interpolating within clips
  function timeToCol(time: number): number {
    if (time <= 0) return 0;
    if (time >= totalDuration) return trackWidth;
    for (let i = clips.length - 1; i >= 0; i--) {
      const clipEnd = clipStartTimes[i] + clipDurations[i];
      if (time >= clipStartTimes[i]) {
        const ratio = (time - clipStartTimes[i]) / clipDurations[i];
        return Math.round(clipStartCol[i] + ratio * clipWidths[i]);
      }
    }
    return 0;
  }

  // Summary line
  const totalSec = Math.round(totalDuration);
  const durStr = totalSec >= 60
    ? `${Math.floor(totalSec / 60)}m${totalSec % 60 > 0 ? ` ${totalSec % 60}s` : ''}`
    : `${totalSec}s`;
  const audioCount = items.filter(i => i.type === 'music').length;
  const voiceoverCount = items.filter(i => i.type === 'voiceover').length;
  let summary = `${durStr} | ${clips.length} clips`;
  if (overlays.length > 0) {
    summary += `, ${overlays.length} overlay${overlays.length > 1 ? 's' : ''}`;
  }
  if (audioCount > 0) {
    summary += `, ${audioCount} music`;
  }
  if (voiceoverCount > 0) {
    summary += `, ${voiceoverCount} voiceover`;
  }
  if (storyName) {
    const gap = trackWidth - summary.length - storyName.length;
    if (gap >= 2) {
      summary += ' '.repeat(gap) + storyName;
    } else {
      summary += '  ' + storyName;
    }
  }

  // Map overlays to column spans
  const overlaySpans: OverlaySpan[] = [];
  for (const o of overlays) {
    const endClipIdx = o.endClip ?? o.startClip;
    if (o.startClip >= clips.length || endClipIdx >= clips.length) continue;
    let startCol = timeToCol(clipAnchoredStart(timings, o.startClip, o.startOffset));
    // Skip past the `~` transition marker
    if (o.startClip > 0 && clips[o.startClip].transition && o.startOffset === 0) {
      startCol = Math.max(startCol, clipStartCol[o.startClip] + 1);
    }
    // endOffset 0 ends before the next clip's incoming transition
    let endCol = timeToCol(clipAnchoredEnd(timings, endClipIdx, o.endOffset, clips));
    if (endCol <= startCol) endCol = startCol + 1;
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

  // Map music items to column spans
  const audioSpans: AudioSpan[] = [];
  for (const a of audios) {
    const endClipIdx = a.endClip ?? a.startClip;
    if (a.startClip >= clips.length || endClipIdx >= clips.length) continue;
    let startCol = timeToCol(clipAnchoredStart(timings, a.startClip, a.startOffset));
    if (a.startClip > 0 && clips[a.startClip].transition && a.startOffset === 0) {
      startCol = Math.max(startCol, clipStartCol[a.startClip] + 1);
    }
    let endCol = timeToCol(clipAnchoredEnd(timings, endClipIdx, a.endOffset));
    if (endCol <= startCol) endCol = startCol + 1;
    let label: string;
    if (a.musicId != null && musicNames?.has(a.musicId)) {
      label = musicNames.get(a.musicId)!;
    } else if (a.musicId != null) {
      label = `a${a.musicId}`;
    } else {
      label = 'gen';
    }
    audioSpans.push({ startCol, endCol, label });
  }

  // Greedy lane assignment for audio
  const sortedAudio = [...audioSpans].sort((a, b) => a.startCol - b.startCol);
  const audioLanes: AudioSpan[][] = [];
  for (const span of sortedAudio) {
    let placed = false;
    for (const lane of audioLanes) {
      if (lane[lane.length - 1].endCol <= span.startCol) {
        lane.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) audioLanes.push([span]);
  }

  // Render clip track
  let clipTrack = '';
  for (let i = 0; i < clips.length; i++) {
    const w = clipWidths[i];
    const clip = clips[i];
    const hasTransition = i > 0 && !!clip.transition;

    // Crop indicators: ◱ = tighter (more cropped), ▣ = wider (less cropped)
    let cropPrefix = '';
    let cropSuffix = '';
    if (clip.cropEnd) {
      const startCrop = clip.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
      const startSum = startCrop.left + startCrop.top + startCrop.right + startCrop.bottom;
      const endSum = clip.cropEnd.left + clip.cropEnd.top + clip.cropEnd.right + clip.cropEnd.bottom;
      if (startSum <= endSum) {
        cropPrefix = '▣';  // start is wider
        cropSuffix = '◱';  // end is tighter
      } else {
        cropPrefix = '◱';  // start is tighter
        cropSuffix = '▣';  // end is wider
      }
    } else if (clip.crop) {
      cropPrefix = '◱';
    }

    const prefix = (hasTransition ? '~[' : '[') + cropPrefix;
    const suffix = cropSuffix + ']';
    const innerWidth = w - prefix.length - suffix.length;
    const label = `v${clips[i].videoId}`;

    const inner = renderClipInner(label, innerWidth);
    clipTrack += prefix + inner + suffix;
  }

  // Map voiceover items to column spans
  const voiceoverSpans: AudioSpan[] = [];
  for (const vo of voiceoversItems) {
    if (vo.startClip >= clips.length) continue;
    const voStartTime = clipAnchoredStart(timings, vo.startClip, vo.startOffset);
    const voEndTime = voStartTime + (sourceFileEndSeconds(vo) - sourceFileStartSeconds(vo));
    let startCol = timeToCol(voStartTime);
    if (vo.startClip > 0 && clips[vo.startClip].transition && vo.startOffset === 0) {
      startCol = Math.max(startCol, clipStartCol[vo.startClip] + 1);
    }
    const endCol = Math.min(timeToCol(voEndTime), trackWidth);
    voiceoverSpans.push({ startCol, endCol, label: `vo${vo.voiceoverId}` });
  }

  // Greedy lane assignment for voiceover
  const sortedVoiceover = [...voiceoverSpans].sort((a, b) => a.startCol - b.startCol);
  const voiceoverLanes: AudioSpan[][] = [];
  for (const span of sortedVoiceover) {
    let placed = false;
    for (const lane of voiceoverLanes) {
      if (lane[lane.length - 1].endCol <= span.startCol) {
        lane.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) voiceoverLanes.push([span]);
  }

  // Apply minimum display width to voiceover spans after lane assignment
  for (const lane of voiceoverLanes) {
    for (let i = 0; i < lane.length; i++) {
      if (lane[i].endCol - lane[i].startCol < 4) {
        const maxEnd = i + 1 < lane.length ? lane[i + 1].startCol : trackWidth;
        lane[i].endCol = Math.min(lane[i].startCol + 4, maxEnd);
      }
    }
  }

  // Assemble output
  const pad = ' '.repeat(padding);
  const lines: string[] = [];
  lines.push(pad + chalk.dim(summary));
  for (let i = lanes.length - 1; i >= 0; i--) {
    lines.push(pad + renderLane(lanes[i], trackWidth));
  }
  lines.push(pad + chalk.cyan(clipTrack));
  for (const lane of voiceoverLanes) {
    lines.push(pad + renderVoiceoverLane(lane, trackWidth));
  }
  for (const lane of audioLanes) {
    lines.push(pad + renderAudioLane(lane, trackWidth));
  }

  return lines;
}
