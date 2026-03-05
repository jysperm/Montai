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

const TITLE_EFFECT_ID = 'r2';
const TITLE_EFFECT_UID =
  '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

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

/**
 * Generate a <title> element with proper text-style structure.
 * The indent parameter controls the base indentation level.
 */
function makeTitleXml(
  text: string,
  tsId: string,
  fontSize: number,
  offset: string,
  duration: string,
  indent: string,
  lane?: number,
): string {
  const laneAttr = lane != null ? ` lane="${lane}"` : '';
  return [
    `${indent}<title ref="${TITLE_EFFECT_ID}" name="${escapeXml(text)}"${laneAttr} offset="${offset}" duration="${duration}" start="0/1s">`,
    `${indent}    <text>`,
    `${indent}        <text-style ref="${tsId}">${escapeXml(text)}</text-style>`,
    `${indent}    </text>`,
    `${indent}    <text-style-def id="${tsId}">`,
    `${indent}        <text-style font="Helvetica" fontSize="${fontSize}" fontFace="Regular" fontColor="1 1 1 1" alignment="center" />`,
    `${indent}    </text-style-def>`,
    `${indent}</title>`,
  ].join('\n');
}

export interface VideoFormatInfo {
  width: number;
  height: number;
  fpsNum: number;    // frame rate numerator, e.g. 60000
  fpsDen: number;    // frame rate denominator, e.g. 1001
  durationSeconds?: number | null;
  totalFrames?: number | null;
  bitDepth?: number | null;
  colorSpace?: string | null;
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
    if (transfer === 'smpte2084') return '9-18-9 (Rec. 2020 PQ)';
    if (transfer === 'arib-std-b67') return '9-18-9 (Rec. 2020 HLG)';
    return '9-1-9 (Rec. 2020)';
  }
  return null;
}

export function generateFcpxml(
  spec: ExpandedTimeline,
  videoMeta?: Map<string, VideoFormatInfo>,
): string {
  const { fps, width, height } = spec;
  let tsCounter = 0;
  const nextTs = () => `ts${++tsCounter}`;

  // --- Build format entries and asset resources ---
  const assetMap = new Map<string, string>(); // filename -> asset id
  const assetStartFrames = new Map<string, { frames: number; fpsNum: number; fpsDen: number }>(); // filename -> timecode start info
  const assetLines: string[] = [];
  const formatLines: string[] = [];
  const formatMap = new Map<string, string>(); // format key -> format id
  let assetIndex = 1;
  let formatIndex = 2; // r1 is the sequence format, start at r2 (but r2 may be title effect)

  // r1 is always the sequence/output format
  // Title effect uses TITLE_EFFECT_ID (r2), so per-asset formats start after that
  const needsTitleEffect = spec.textOverlays.length > 0;
  if (needsTitleEffect) formatIndex = 3; // r2 is taken by title effect

  function getOrCreateFormat(meta: VideoFormatInfo): string {
    const key = `${meta.width}x${meta.height}@${meta.fpsNum}/${meta.fpsDen}`;
    const fpsApprox = Math.round(meta.fpsNum / meta.fpsDen);
    // If it matches the sequence format, use r1
    if (meta.width === width && meta.height === height && meta.fpsNum === fps && meta.fpsDen === 1) {
      return 'r1';
    }
    if (formatMap.has(key)) return formatMap.get(key)!;

    const id = `r${formatIndex++}`;
    formatMap.set(key, id);
    formatLines.push(
      `        <format id="${id}" name="FFVideoFormat${meta.height}p${fpsApprox}" frameDuration="${meta.fpsDen}/${meta.fpsNum}s" width="${meta.width}" height="${meta.height}" />`
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

      const audioAttrs = meta?.audioChannels
        ? ` audioSources="1" audioChannels="${meta.audioChannels}" audioRate="${meta.audioSampleRate ?? 48000}"`
        : '';
      assetLines.push(
        [
          `        <asset id="${id}" start="${assetStart}" duration="${assetDuration}" hasVideo="1" hasAudio="1"${audioAttrs} format="${formatId}">`,
          `            <media-rep kind="original-media" src="file://./${escapeXml(filename)}" />`,
          `        </asset>`,
        ].join('\n')
      );
    }
  }

  // --- Build spine elements ---
  const spine: string[] = [];
  let offset = 0;
  const I = '                    '; // base indent for spine children

  // Video clips with transitions
  for (let i = 0; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    const clipDuration =
      (clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate;
    const assetId = getAssetId(clip, spec.clips);

    // Transition before clip (except first clip)
    if (i > 0 && clip.transition && clip.transition.type !== 'none') {
      const transitionFrames = Math.round(clip.transition.durationSeconds * fps);
      if (transitionFrames > 0) {
        spine.push(
          `${I}<transition name="${clip.transition.type}" offset="${toRational(offset, fps)}" duration="${transitionFrames}/${fps}s" />`
        );
        offset -= transitionFrames / fps;
      }
    }

    // Compute source start time: timecode offset + clip in-point
    const clipFilename = basename(clip.sourceFile);
    const tcInfo = assetStartFrames.get(clipFilename);
    let clipStart: string;
    if (tcInfo && tcInfo.frames > 0) {
      const clipOffsetFrames = Math.round(clip.startTimeSeconds * tcInfo.fpsNum / tcInfo.fpsDen);
      clipStart = framesToRational(tcInfo.frames + clipOffsetFrames, tcInfo.fpsNum, tcInfo.fpsDen);
    } else {
      clipStart = toRational(clip.startTimeSeconds, fps);
    }

    spine.push(
      `${I}<asset-clip ref="${assetId}" name="${escapeXml(clipFilename)}" offset="${toRational(offset, fps)}" duration="${toRational(clipDuration, fps)}" start="${clipStart}" tcFormat="NDF" />`
    );
    offset += clipDuration;
  }

  // Text overlays as connected titles (lane 1)
  for (const overlay of spec.textOverlays) {
    const overlayOffset = toRational(overlay.startTimeSeconds, fps);
    const overlayDuration = toRational(
      overlay.endTimeSeconds - overlay.startTimeSeconds,
      fps,
    );
    const fontSize =
      overlay.style === 'title' ? 64 : overlay.style === 'subtitle' ? 36 : 24;

    spine.push(makeTitleXml(overlay.text, nextTs(), fontSize, overlayOffset, overlayDuration, I, 1));
  }

  const totalDuration = toRational(offset, fps);

  const allFormatLines = [
    `        <format id="r1" name="FFVideoFormat${height}p${Math.round(fps)}" frameDuration="1/${fps}s" width="${width}" height="${height}" />`,
    ...formatLines,
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
    <resources>
${allFormatLines.join('\n')}${needsTitleEffect ? `\n        <effect id="${TITLE_EFFECT_ID}" name="Basic Title" uid="${TITLE_EFFECT_UID}" />` : ''}
${assetLines.join('\n')}
    </resources>
    <library>
        <event name="Montai Export">
            <project name="${escapeXml(spec.name)}">
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
