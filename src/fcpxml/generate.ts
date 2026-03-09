import { basename } from 'path';
import type { ExpandedTimeline, ExpandedClip } from '../schemas/timeline.js';

function toRational(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  return `${frames}/${fps}s`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// FCP built-in effect UIDs.
// DaVinci Resolve only reliably maps Cross Dissolve during FCPXML import;
// Slide and Wipe fall back to dissolve (DaVinci FCPXML import limitation).
const TITLE_EFFECT_UID =
  '.../Titles.localized/Essential Titles.localized/Essential Title.localized/Essential Title.moti';
const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
const SLIDE_UID = 'FxPlug:6AAB0D54-FCD8-4EBD-A62D-D352A5ED1648';
const WIPE_UID = 'FxPlug:857E2FBA-98DB-411B-A88C-CE6ABC1F65D8';
const AUDIO_CROSSFADE_UID = 'FFAudioTransition';

// Direction mapping: Remotion direction → FCP param value
// Slide: param key "4", Wipe: param key "13"
// FCP names transitions by the direction of motion (e.g. "Slide Left" = content moves left = new clip enters from right)
function fcpDirectionValue(direction?: string): string {
  switch (direction) {
    case 'from-right': return '0';   // Left variant
    case 'from-bottom': return '1';  // Up variant
    case 'from-left': return '2';    // Right variant
    case 'from-top': return '3';     // Down variant
    default: return '0';             // default: from-right (Left variant)
  }
}

function getAssetId(clip: ExpandedClip, clips: ExpandedClip[]): string {
  const filename = basename(clip.sourceFile);
  const seen = new Set<string>();
  let index = 0;
  for (const c of clips) {
    const fn = basename(c.sourceFile);
    if (!seen.has(fn)) {
      index++;
      seen.add(fn);
    }
    if (fn === filename) return `asset-${index}`;
  }
  return 'asset-1';
}

// Essential Title positioning via Motion template params.
// The template has a fixed 3840×2160 canvas (origin at center, X right+, Y up+).
// All font sizes, shadow dimensions, and position coordinates must be expressed in
// this template space. For a 1080p project, the template is scaled 2× to fit,
// so template values = project values × 2. The scale factor is always
// TMPL_HEIGHT / 1080 = 2, independent of project resolution.
const TMPL_HALF_W = 1920;
const TMPL_HALF_H = 1080;
const TMPL_MARGIN = 80;  // 40px at 1080p × 2
const TMPL_SCALE = 2;    // 2160 / 1080

// Paragraph margins from the Essential Title Motion template define the text layout
// area relative to the title object center. With default alignment (center/center),
// the text center is approximately at the Position param value (the ±69 asymmetry
// in paragraph margins is offset by the template's default text Position.Y = 69).
const PARA_L = -1600; // paragraph left margin
const PARA_R = 1600;  // paragraph right margin

// Position key for Essential Title (Properties > Transform > Position)
const POS_KEY = '9999/10085/10086/1/100/101';

/**
 * Generate <param> elements for Essential Title positioning.
 * Returns empty string for center (default, no params needed).
 * DaVinci ignores Motion template params — titles render at center there regardless.
 *
 * Horizontal: uses text-style `alignment` for paragraph alignment (left/center/right)
 * plus Position.X to shift the text area so the aligned edge is at frame margin.
 * Vertical: uses Position.Y to place the text center at the target Y, adjusted for
 * font size so the text edge sits at the margin. The Alignment Motion param (key 373)
 * is not used because FCP ignores it during FCPXML import.
 */
function fcpTitleParams(position: string, indent: string, fontSizeTmpl: number): string {
  if (position === 'center') return '';

  // Horizontal: shift text area so aligned edge is at frame edge ± margin
  // Left: text starts at Position.X + PARA_L → want at -TMPL_HALF_W + TMPL_MARGIN
  // Right: text ends at Position.X + PARA_R → want at TMPL_HALF_W - TMPL_MARGIN
  const xLeft = -TMPL_HALF_W + TMPL_MARGIN - PARA_L;   // -240
  const xRight = TMPL_HALF_W - TMPL_MARGIN - PARA_R;    // 240

  // Vertical: position text center so its edge is at frame edge ± margin
  // Bottom: text bottom = textCenter - fontSize/2 → want at -TMPL_HALF_H + TMPL_MARGIN
  // Top: text top = textCenter + fontSize/2 → want at TMPL_HALF_H - TMPL_MARGIN
  const halfFont = Math.round(fontSizeTmpl / 2);
  const yBottom = -TMPL_HALF_H + TMPL_MARGIN + halfFont;
  const yTop = TMPL_HALF_H - TMPL_MARGIN - halfFont;

  let posX = 0, posY = 0;
  switch (position) {
    case 'top-left':      posX = xLeft;  posY = yTop;    break;
    case 'top-right':     posX = xRight; posY = yTop;    break;
    case 'bottom-left':   posX = xLeft;  posY = yBottom; break;
    case 'bottom-center': posX = 0;      posY = yBottom; break;
    case 'bottom-right':  posX = xRight; posY = yBottom; break;
    default: return '';
  }

  return [
    '',
    `${indent}<param name="Position" key="${POS_KEY}" value="${posX} ${posY}"/>`,
  ].join('\n');
}

/**
 * Generate a <title> element with proper text-style structure.
 * Used as a connected clip (anchor item) inside an asset-clip with lane="1".
 */
function makeTitleXml(
  text: string,
  tsId: string,
  fontSize: number,
  bold: boolean,
  shadowOffset: number,
  shadowBlur: number,
  offset: string,
  duration: string,
  indent: string,
  titleEffectId: string,
  position: string,
): string {
  const alignment = position === 'center' || position === 'bottom-center'
    ? 'center' : position.endsWith('-left') ? 'left' : 'right';
  const boldAttr = bold ? ' bold="1"' : '';
  // Match Remotion's textShadow: 0 2px 8px rgba(0,0,0,0.8)
  const shadowAttrs = ` shadowColor="0 0 0 0.8" shadowOffset="${shadowOffset} ${shadowOffset}" shadowBlurRadius="${shadowBlur}"`;
  const positionParams = fcpTitleParams(position, `${indent}    `, fontSize);

  const lines = [
    `${indent}<title ref="${titleEffectId}" lane="1" name="${escapeXml(text.replace(/\n/g, ' '))}" offset="${offset}" duration="${duration}" start="0/1s">${positionParams}`,
    `${indent}    <text>`,
    `${indent}        <text-style ref="${tsId}">${escapeXml(text)}</text-style>`,
    `${indent}    </text>`,
    `${indent}    <text-style-def id="${tsId}">`,
    `${indent}        <text-style font="Helvetica Neue" fontSize="${fontSize}" fontFace="Regular" fontColor="1 1 1 1"${boldAttr} alignment="${alignment}"${shadowAttrs} />`,
    `${indent}    </text-style-def>`,
    `${indent}</title>`,
  ];

  return lines.join('\n');
}

export interface VideoFormatInfo {
  width: number;
  height: number;
  fpsNum: number;    // frame rate numerator, e.g. 60000
  fpsDen: number;    // frame rate denominator, e.g. 1001
  durationSeconds?: number | null;
  totalFrames?: number | null;
  bitDepth?: number | null;
  colorPrimaries?: string | null;
  colorTransfer?: string | null;
  audioChannels?: number | null;
  audioSampleRate?: number | null;
  startTimecode?: string | null;   // e.g. "15:03:38;24"
}

/**
 * Parse a timecode string (HH:MM:SS:FF or HH:MM:SS;FF) to a frame count
 * in the video rate timebase.
 *
 * For high frame rate video (>30fps), the container's tmcd track stores
 * timecodes at the base rate (e.g. 30fps for 59.94fps video, 25fps for 50fps).
 * We parse at the base rate and scale up to match the video rate, ensuring
 * our computed start time matches what FCP reads from the file.
 */
function parseTimecodeToFrames(tc: string, fpsNum: number, fpsDen: number): number {
  const isDF = tc.includes(';');
  const parts = tc.split(/[:;]/);
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  const f = parseInt(parts[3], 10);
  const nomFps = Math.round(fpsNum / fpsDen); // e.g. 60 for 59.94, 30 for 29.97

  // High frame rates use a half-rate (or quarter-rate) timecode track.
  // Parse at the base rate, then scale to the video rate.
  const tcMultiplier = nomFps > 30 ? Math.ceil(nomFps / 30) : 1;
  const tcNomFps = Math.round(nomFps / tcMultiplier);

  let tcFrames: number;
  if (isDF) {
    // Drop-frame at base rate: D=2 for 29.97fps base
    const D = tcNomFps === 30 ? 2 : 0;
    const totalMinutes = h * 60 + m;
    const dropMinutes = totalMinutes - Math.floor(totalMinutes / 10);
    tcFrames = h * 3600 * tcNomFps + m * 60 * tcNomFps + s * tcNomFps + f - D * dropMinutes;
  } else {
    tcFrames = h * 3600 * tcNomFps + m * 60 * tcNomFps + s * tcNomFps + f;
  }

  return tcFrames * tcMultiplier;
}

/**
 * Convert a frame count to a rational FCPXML time string using the source fps.
 */
function framesToRational(frames: number, fpsNum: number, fpsDen: number): string {
  return `${frames * fpsDen}/${fpsNum}s`;
}

export function mapFcpxmlColorSpace(meta: VideoFormatInfo): string | null {
  const primaries = meta.colorPrimaries;
  const transfer = meta.colorTransfer;
  if (!primaries) return null;

  if (primaries === 'bt709') return '1-1-1 (Rec. 709)';
  if (primaries === 'bt2020') {
    if (transfer === 'pq') return '9-16-9 (Rec. 2020 PQ)';
    if (transfer === 'hlg') return '9-18-9 (Rec. 2020 HLG)';
    return '9-1-9 (Rec. 2020)';
  }
  return null;
}

export function generateFcpxml(
  spec: ExpandedTimeline,
  videoMeta?: Map<string, VideoFormatInfo>,
  options?: { eventName?: string; projectTitle?: string; target?: 'fcp' | 'davinci' },
): string {
  const target = options?.target ?? 'fcp';
  const { fps, width, height } = spec;
  let tsCounter = 0;
  const nextTs = () => `ts${++tsCounter}`;

  // --- Build format entries and asset resources ---
  const assetMap = new Map<string, string>(); // filename -> asset id
  const assetFormatMap = new Map<string, string>(); // filename -> format id
  const assetStartFrames = new Map<string, { frames: number; fpsNum: number; fpsDen: number }>();
  const assetLines: string[] = [];
  const formatLines: string[] = [];
  const formatMap = new Map<string, string>(); // format key -> format id
  let assetIndex = 1;

  // Dynamic resource ID allocation: r1 = sequence format, then effects, then per-source formats
  let nextResourceId = 2;
  const needsTitleEffect = spec.textOverlays.length > 0;
  const titleEffectId = needsTitleEffect ? `r${nextResourceId++}` : null;
  // Determine which transition effects are used.
  // DaVinci only reliably imports Cross Dissolve, so map all transitions to fade.
  const usedTransitionTypes = new Set<string>();
  for (let i = 1; i < spec.clips.length; i++) {
    const trans = spec.clips[i].transition;
    if (trans) {
      usedTransitionTypes.add(target === 'davinci' ? 'fade' : trans.type);
    }
  }
  const crossDissolveId = usedTransitionTypes.has('fade') ? `r${nextResourceId++}` : null;
  const slideId = usedTransitionTypes.has('slide') ? `r${nextResourceId++}` : null;
  const wipeId = usedTransitionTypes.has('wipe') ? `r${nextResourceId++}` : null;
  const audioCrossfadeId = usedTransitionTypes.size > 0 ? `r${nextResourceId++}` : null;
  let formatIndex = nextResourceId;

  let detectedHdr = false;

  function getOrCreateFormat(meta: VideoFormatInfo): string {
    const colorSpace = mapFcpxmlColorSpace(meta);
    const key = `${meta.width}x${meta.height}@${meta.fpsNum}/${meta.fpsDen}:${colorSpace ?? ''}`;
    const fpsApprox = Math.round(meta.fpsNum / meta.fpsDen);

    if (colorSpace && (colorSpace.includes('HLG') || colorSpace.includes('PQ'))) detectedHdr = true;

    // If it matches the sequence format, use r1
    if (meta.width === width && meta.height === height && meta.fpsNum === fps && meta.fpsDen === 1) {
      return 'r1';
    }
    if (formatMap.has(key)) return formatMap.get(key)!;

    const id = `r${formatIndex++}`;
    formatMap.set(key, id);
    const colorSpaceAttr = colorSpace ? ` colorSpace="${colorSpace}"` : '';
    formatLines.push(
      `        <format id="${id}" name="FFVideoFormat${meta.height}p${fpsApprox}" frameDuration="${meta.fpsDen}/${meta.fpsNum}s" width="${meta.width}" height="${meta.height}"${colorSpaceAttr} />`
    );
    return id;
  }

  for (const clip of spec.clips) {
    const filename = basename(clip.sourceFile);
    if (!assetMap.has(filename)) {
      const id = `asset-${assetIndex++}`;
      assetMap.set(filename, id);
      const maxEnd = spec.clips
        .filter((c) => basename(c.sourceFile) === filename)
        .reduce((max, c) => Math.max(max, c.endTimeSeconds), 0);

      const meta = videoMeta?.get(filename);
      const formatId = meta ? getOrCreateFormat(meta) : 'r1';
      assetFormatMap.set(filename, formatId);
      // Use source fps rational components for asset duration; fall back to sequence fps
      const assetFpsNum = meta?.fpsNum ?? fps;
      const assetFpsDen = meta?.fpsDen ?? 1;
      // Prefer frame-exact duration from totalFrames; fall back to seconds-based estimate
      let assetDuration: string;
      if (meta?.totalFrames && meta.totalFrames > 0) {
        assetDuration = `${meta.totalFrames * assetFpsDen}/${assetFpsNum}s`;
      } else {
        const assetSeconds = meta?.durationSeconds ?? (maxEnd + 10);
        const durationTicks = Math.floor(assetSeconds * assetFpsNum / assetFpsDen);
        assetDuration = `${durationTicks * assetFpsDen}/${assetFpsNum}s`;
      }

      // Compute asset start time from embedded timecode
      let assetStart = '0/1s';
      const tcStartFrames = meta?.startTimecode
        ? parseTimecodeToFrames(meta.startTimecode, assetFpsNum, assetFpsDen)
        : 0;
      if (tcStartFrames > 0) {
        assetStart = framesToRational(tcStartFrames, assetFpsNum, assetFpsDen);
      }
      assetStartFrames.set(filename, { frames: tcStartFrames, fpsNum: assetFpsNum, fpsDen: assetFpsDen });

      // Absolute file:// URL so FCP/DaVinci can locate the source media directly
      const srcUrl = `file://${escapeXml(clip.sourceFile || filename)}`;

      const audioAttrs = meta?.audioChannels
        ? ` audioSources="1" audioChannels="${meta.audioChannels}" audioRate="${meta.audioSampleRate ?? 48000}"`
        : '';
      assetLines.push(
        [
          `        <asset id="${id}" start="${assetStart}" duration="${assetDuration}" hasVideo="1" hasAudio="1"${audioAttrs} format="${formatId}">`,
          `            <media-rep kind="original-media" src="${srcUrl}" />`,
          `        </asset>`,
        ].join('\n')
      );
    }
  }

  // --- Build spine elements (sequential model with handle negotiation) ---
  // FCP sequential model: clips placed end-to-end with explicit offsets.
  // Transitions require source media handles (extra frames beyond clip in/out).
  // FCP requires roughly centered transitions — asymmetric ones render shortened.
  // Source shifts are pre-computed per clip considering both adjacent transitions:
  //   positive shift → creates pre-handle (for transition entering the clip)
  //   negative shift → creates post-handle (for transition leaving the clip)
  // When a clip can't satisfy both sides, the smaller deficit is prioritized.
  // Titles are nested inside clips as connected anchor items (lane=1).
  const spine: string[] = [];
  let seqOffset = 0;
  const I = '                    '; // base indent for spine children
  const II = I + '    '; // indent for items inside a clip

  // Pre-compute clip durations
  const clipDurations: number[] = [];
  for (const clip of spec.clips) {
    clipDurations.push((clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate);
  }

  // The timeline spec uses an overlapping model (clips overlap by transition duration),
  // but FCPXML uses a sequential model (clips placed end-to-end, transitions borrow
  // handles from adjacent clips). We need both coordinate systems to correctly map
  // overlay positions from the spec onto sequential clip positions in FCPXML.
  const clipOverlapStarts: number[] = [];
  const clipSeqStarts: number[] = [];
  {
    let sOverlap = 0;
    let sSeq = 0;
    for (let i = 0; i < spec.clips.length; i++) {
      const trans = spec.clips[i].transition;
      if (i > 0 && trans) {
        sOverlap -= trans.durationSeconds;
      }
      clipOverlapStarts.push(sOverlap);
      clipSeqStarts.push(sSeq);
      sOverlap += clipDurations[i];
      sSeq += clipDurations[i];
    }
  }

  // Map a time from the overlapping model to the sequential model
  function overlapToSeq(t: number): number {
    for (let i = spec.clips.length - 1; i >= 0; i--) {
      if (t >= clipOverlapStarts[i]) {
        return clipSeqStarts[i] + (t - clipOverlapStarts[i]);
      }
    }
    return t;
  }

  // Assign overlays to their parent clips (in sequential timeline positions)
  const clipOverlays = new Map<number, typeof spec.textOverlays>();
  for (const overlay of spec.textOverlays) {
    const seqStart = overlapToSeq(overlay.startTimeSeconds);
    for (let i = spec.clips.length - 1; i >= 0; i--) {
      if (seqStart >= clipSeqStarts[i]) {
        if (!clipOverlays.has(i)) clipOverlays.set(i, []);
        clipOverlays.get(i)!.push(overlay);
        break;
      }
    }
  }

  // Pre-compute transition frame counts (rounded to even for centering)
  const transFrames: number[] = new Array(spec.clips.length).fill(0);
  for (let i = 1; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    if (clip.transition) {
      let frames = Math.round(clip.transition.durationSeconds * fps);
      if (frames % 2 !== 0) frames += 1;
      transFrames[i] = frames;
    }
  }

  // Pre-compute source shifts. Each clip's valid shift range is [shiftMin, shiftMax]:
  //   shiftMin = pre-handle needed for incoming transition − natural pre-handle
  //   shiftMax = natural post-handle − post-handle needed for outgoing transition
  // We pick shift = clamp(0, shiftMin, shiftMax), preferring no shift when possible.
  const sourceShifts: number[] = new Array(spec.clips.length).fill(0);
  for (let i = 0; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    const meta = videoMeta?.get(basename(clip.sourceFile));
    if (!meta?.durationSeconds) continue;

    const preNeeded = (transFrames[i] / fps) / 2;
    const postNeeded = (i + 1 < spec.clips.length) ? (transFrames[i + 1] / fps) / 2 : 0;

    const shiftMin = preNeeded - clip.startTimeSeconds;
    const shiftMax = meta.durationSeconds - clip.endTimeSeconds - postNeeded;

    if (shiftMin <= shiftMax) {
      sourceShifts[i] = Math.max(shiftMin, Math.min(0, shiftMax));
    } else {
      // Can't satisfy both transitions — save at least one.
      const preFeasible = shiftMin <= (meta.durationSeconds - clip.endTimeSeconds);
      const postFeasible = -shiftMax <= clip.startTimeSeconds;
      if (preFeasible && postFeasible) {
        sourceShifts[i] = Math.abs(shiftMin) <= Math.abs(shiftMax) ? shiftMin : shiftMax;
      } else if (preFeasible) {
        sourceShifts[i] = shiftMin;
      } else if (postFeasible) {
        sourceShifts[i] = shiftMax;
      }
    }
  }

  // Generate spine elements
  for (let i = 0; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    const clipDuration = clipDurations[i];
    const assetId = getAssetId(clip, spec.clips);

    // Emit centered transition if both sides have sufficient handles after shifts
    if (i > 0 && transFrames[i] > 0) {
      const halfTransSec = (transFrames[i] / fps) / 2;
      const prevClip = spec.clips[i - 1];
      const prevMeta = videoMeta?.get(basename(prevClip.sourceFile));
      const prevPostHandle = prevMeta?.durationSeconds
        ? prevMeta.durationSeconds - (prevClip.endTimeSeconds + sourceShifts[i - 1])
        : Infinity;
      const curPreHandle = clip.startTimeSeconds + sourceShifts[i];

      if (curPreHandle >= halfTransSec && prevPostHandle >= halfTransSec) {
        const boundaryFrames = Math.round(seqOffset * fps);
        const halfFrames = transFrames[i] / 2;
        const transOffsetFrames = boundaryFrames - halfFrames;
        const transType = target === 'davinci' ? 'fade' : clip.transition!.type;
        const transDir = clip.transition!.direction;

        // Resolve effect ref and name based on transition type
        let videoEffectRef: string | null = null;
        let videoEffectName = '';
        let directionParam = '';
        if (transType === 'fade' && crossDissolveId) {
          videoEffectRef = crossDissolveId;
          videoEffectName = 'Cross Dissolve';
        } else if (transType === 'slide' && slideId) {
          videoEffectRef = slideId;
          videoEffectName = 'Slide';
          directionParam = `${I}        <param name="Direction" key="4" value="${fcpDirectionValue(transDir)}" />`;
        } else if (transType === 'wipe' && wipeId) {
          videoEffectRef = wipeId;
          videoEffectName = 'Wipe';
          directionParam = `${I}        <param name="Direction" key="13" value="${fcpDirectionValue(transDir)}" />`;
        }

        if (videoEffectRef && audioCrossfadeId) {
          const filterVideoLines: string[] = [];
          if (directionParam) {
            filterVideoLines.push(`${I}    <filter-video ref="${videoEffectRef}" name="${videoEffectName}">`);
            filterVideoLines.push(directionParam);
            filterVideoLines.push(`${I}    </filter-video>`);
          } else {
            filterVideoLines.push(`${I}    <filter-video ref="${videoEffectRef}" name="${videoEffectName}" />`);
          }
          spine.push([
            `${I}<transition offset="${transOffsetFrames}/${fps}s" duration="${transFrames[i]}/${fps}s">`,
            ...filterVideoLines,
            `${I}    <filter-audio ref="${audioCrossfadeId}" name="Audio Cross Fade" />`,
            `${I}</transition>`,
          ].join('\n'));
        } else {
          spine.push(`${I}<transition offset="${transOffsetFrames}/${fps}s" duration="${transFrames[i]}/${fps}s" />`);
        }
      }
    }

    // Compute source start time: timecode offset + clip in-point (with shift)
    const clipFilename = basename(clip.sourceFile);
    const tcInfo = assetStartFrames.get(clipFilename);
    const effectiveStartSeconds = clip.startTimeSeconds + sourceShifts[i];
    let clipStart: string;
    if (tcInfo && tcInfo.frames > 0) {
      const clipOffsetFrames = Math.round(effectiveStartSeconds * tcInfo.fpsNum / tcInfo.fpsDen);
      clipStart = framesToRational(tcInfo.frames + clipOffsetFrames, tcInfo.fpsNum, tcInfo.fpsDen);
    } else {
      clipStart = toRational(effectiveStartSeconds, fps);
    }

    const clipFormatId = assetFormatMap.get(clipFilename);
    const formatAttr = clipFormatId && clipFormatId !== 'r1' ? ` format="${clipFormatId}"` : '';

    // Check for overlay titles attached to this clip
    const overlays = clipOverlays.get(i) || [];

    if (overlays.length === 0) {
      spine.push(
        `${I}<asset-clip ref="${assetId}" name="${escapeXml(clipFilename)}" offset="${toRational(seqOffset, fps)}" duration="${toRational(clipDuration, fps)}" start="${clipStart}"${formatAttr} tcFormat="NDF" />`
      );
    } else {
      spine.push(
        `${I}<asset-clip ref="${assetId}" name="${escapeXml(clipFilename)}" offset="${toRational(seqOffset, fps)}" duration="${toRational(clipDuration, fps)}" start="${clipStart}"${formatAttr} tcFormat="NDF">`
      );

      // Font sizes and shadow dimensions scale factor:
      // FCP: 2× (Essential Title template renders at 3840×2160 and scales to project)
      // DaVinci: 1× (reads text-style fontSize directly, no template scaling)
      const scale = target === 'fcp' ? TMPL_SCALE : 1;
      const shadowOffsetPx = Math.round(2 * scale);
      const shadowBlurPx = Math.round(8 * scale);

      for (const overlay of overlays) {
        const fontSize = overlay.style === 'title' ? Math.round(80 * scale) : overlay.style === 'subtitle' ? Math.round(48 * scale) : Math.round(32 * scale);
        const isBold = overlay.style === 'title';
        const overlaySeqStart = overlapToSeq(overlay.startTimeSeconds);
        const overlaySeqEnd = overlapToSeq(overlay.endTimeSeconds);
        const deltaInClip = overlaySeqStart - clipSeqStarts[i];

        // Title offset must be in the parent clip's source timebase. When the
        // source fps differs from the sequence fps (e.g. 59.94 vs 50), this offset
        // can't align with both frame grids — FCP warns "not on edit frame boundary"
        // but the title displays correctly.
        let titleOffset: string;
        if (tcInfo && tcInfo.frames > 0) {
          const clipInFrames = Math.round(effectiveStartSeconds * tcInfo.fpsNum / tcInfo.fpsDen);
          const deltaFrames = Math.round(deltaInClip * tcInfo.fpsNum / tcInfo.fpsDen);
          titleOffset = framesToRational(tcInfo.frames + clipInFrames + deltaFrames, tcInfo.fpsNum, tcInfo.fpsDen);
        } else {
          titleOffset = toRational(effectiveStartSeconds + deltaInClip, fps);
        }

        const titleDuration = toRational(overlaySeqEnd - overlaySeqStart, fps);
        // DaVinci ignores Motion template params, so skip position params
        const effectivePosition = target === 'davinci' ? 'center' : overlay.position;
        spine.push(makeTitleXml(overlay.text, nextTs(), fontSize, isBold, shadowOffsetPx, shadowBlurPx, titleOffset, titleDuration, II, titleEffectId!, effectivePosition));
      }

      spine.push(`${I}</asset-clip>`);
    }

    seqOffset += clipDuration;
  }

  const totalDuration = toRational(seqOffset, fps);

  const sequenceColorSpaceAttr = detectedHdr ? '' : ' colorSpace="1-1-1 (Rec. 709)"';
  const effectLines: string[] = [];
  if (titleEffectId) effectLines.push(`        <effect id="${titleEffectId}" name="Basic Title" uid="${TITLE_EFFECT_UID}" />`);
  if (crossDissolveId) effectLines.push(`        <effect id="${crossDissolveId}" name="Cross Dissolve" uid="${CROSS_DISSOLVE_UID}" />`);
  if (slideId) effectLines.push(`        <effect id="${slideId}" name="Slide" uid="${SLIDE_UID}" />`);
  if (wipeId) effectLines.push(`        <effect id="${wipeId}" name="Wipe" uid="${WIPE_UID}" />`);
  if (audioCrossfadeId) effectLines.push(`        <effect id="${audioCrossfadeId}" name="Audio Cross Fade" uid="${AUDIO_CROSSFADE_UID}" />`);

  const allFormatLines = [
    `        <format id="r1" name="FFVideoFormat${height}p${Math.round(fps)}" frameDuration="1/${fps}s" width="${width}" height="${height}"${sequenceColorSpaceAttr} />`,
    ...formatLines,
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
    <resources>
${allFormatLines.join('\n')}${effectLines.length > 0 ? '\n' + effectLines.join('\n') : ''}
${assetLines.join('\n')}
    </resources>
    <library>
        <event name="${escapeXml(options?.eventName ?? 'Montai Export')}">
            <project name="${escapeXml(options?.projectTitle ?? spec.name)}">
                <sequence format="r1" duration="${totalDuration}" tcStart="0/1s" tcFormat="NDF">
                    <spine>
${spine.join('\n')}
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
`;
}
