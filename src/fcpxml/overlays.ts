// Text-overlay (title) rendering for the FCPXML exporter: on-screen sizing,
// edge-based positioning, the Essential Titles template family, and the per-title
// <title> XML. generate.ts owns resource-id allocation and the spine call site;
// everything about how an overlay looks lives here.

import type { ResolvedOverlay } from '../schemas/timeline.js';
import { escapeXml, fcpName, round4, toRational } from './utils.js';

const LINE_HEIGHT = 1.2;  // on-screen line spacing as a multiple of the visual font size

// Base on-screen font sizes (px at 1080 short edge), matching Remotion.
const TITLE_FONT_PX = { title: 80, subtitle: 48, caption: 32 } as const;
const TITLE_MARGIN_PX = 40;          // edge margin at 1080 short edge

// Per-orientation vertical-anchor tuning. Text is anchored by its OUTER EDGE so
// different styles (caption/subtitle/title) and multi-line blocks share the same
// top/bottom line. `topGap`/`bottomGap` are font-size-independent px (at 1080
// short edge, ×s) from the frame margin to the text's outer edge; `baseline` is
// a fontPx-fraction upward shift for centered titles. Values are calibrated
// against FCP imports to preserve the single-line subtitle positions while
// letting other styles edge-align. They differ per aspect because the landscape
// (fontSize) path and the narrow-frame (scale) path place text differently:
// under conform (narrow frames) FCP ignores the generated fontSize/position and
// the title is instead sized by raster scale, so the edge geometry differs.
// captionFixCoeff realigns a bottom caption's edge to the bottom subtitle edge.
// The line-height edge model leaves a per-font-size residual and bottomGap is tuned
// to the subtitle, so the smaller caption lands off by coeff×(subtitlePx−captionPx)×s;
// the coefficient is measured (Y-up: + = up; sign flips by render path).
const TITLE_ANCHOR = {
  landscape: { topGap: -20.64, bottomGap: 28.8, baseline: 0.18, captionFixCoeff: 0.6 },
  vertical:  { topGap: 3.84, bottomGap: 3.84, baseline: 0, captionFixCoeff: -0.2 },
  square:    { topGap: -0.96, bottomGap: -0.96, baseline: 0, captionFixCoeff: -0.2 },
} as const;

// In narrow (vertical/square) frames the Essential Title's 1920×1080 canvas is
// conformed into the sequence; under that conform FCP ignores the generated
// text-style fontSize entirely and renders at the template's default size, so
// fontSize can't set size there. Instead we render at a fixed base fontSize and
// shrink the whole title with <adjust-transform scale>, which scales the
// rendered raster and is unaffected by the conform. The scale mapping the
// rendered size to the title target was measured in FCP; it's
// resolution-independent (the conform scales with the frame) but differs by
// aspect. Subtitle/caption scale down proportionally from the title scale.
const TITLE_SCALE_BASE_FONTSIZE = 60;
const TITLE_SCALE_VERTICAL = 0.74;   // 9:16
const TITLE_SCALE_SQUARE = 0.86;     // 1:1

// FCP built-in Essential Titles template UIDs.
const TITLE_EFFECT_UID = '.../Titles.localized/Essential Titles.localized/Essential Title.localized/Essential Title.moti';
const TITLE_FADE_UID = '.../Titles.localized/Essential Titles.localized/Essential Fade.localized/Essential Fade.moti';
const TITLE_SCALE_UID = '.../Titles.localized/Essential Titles.localized/Essential Scale.localized/Essential Scale.moti';

export interface TitleLayout {
  width: number;        // sequence width (px)
  height: number;       // sequence height (px)
  shortEdge: number;    // min(width, height) (px)
  fontScale: number;    // text-style fontSize multiplier (font-sizing mode)
  scaleMode: boolean;   // true → fixed fontSize + adjust-transform scale (FCP narrow)
  aspectScale: number;  // title-size scale used in scaleMode
}

export function buildTitleLayout(width: number, height: number, target: 'fcp' | 'davinci'): TitleLayout {
  const shortEdge = Math.min(width, height);
  // Landscape (and DaVinci, which ignores the template) size titles via fontSize;
  // FCP conforms the title canvas in vertical/square and ignores the generated
  // fontSize there, so use the adjust-transform scale path.
  const scaleMode = target === 'fcp' && width <= height;
  const aspectScale = width < height ? TITLE_SCALE_VERTICAL : TITLE_SCALE_SQUARE;
  // Font-sizing mode: FCP renders fontSize at value × height/2160, so fontScale =
  // (shortEdge/1080) × (2160/height) = 2·shortEdge/height (2× for landscape).
  const fontScale = target === 'fcp' ? 2 * shortEdge / height : 1;
  return { width, height, shortEdge, fontScale, scaleMode, aspectScale };
}

// Compute a title's on-screen anchor as an <adjust-transform> position.
// FCP transform position on a title is in PERCENT OF SEQUENCE HEIGHT for both
// axes (origin at center, Y-up): position = screenPx × 100 / height. The text's
// aligned edge anchors at the position (left edge for left-align, right edge for
// right-align, center for center), so we target edges directly — no width guess.
function titleTransformPos(
  position: string, style: 'title' | 'subtitle' | 'caption', lineCount: number,
  layout: TitleLayout,
): { tx: number; ty: number; alignment: 'left' | 'center' | 'right' } {
  const { width: W, height: H, shortEdge } = layout;
  const s = shortEdge / 1080;
  const margin = TITLE_MARGIN_PX * s;
  const fontPx = TITLE_FONT_PX[style] * s;
  const halfW = W / 2, halfH = H / 2;

  // Both quantities derive from the on-screen (visual) font size, so they're the
  // same across the scale and fontSize render paths and across styles: lineStep
  // is the multi-line center-to-center spacing; halfLine converts a line center
  // to its outer visual edge (used for edge-aligning different styles).
  const lineStep = LINE_HEIGHT * fontPx;
  const halfLine = lineStep / 2;

  // Anchor by outer edge: the outer line's far edge sits a fixed gap from the
  // margin (font-size independent), so every style aligns on the same line.
  const m = W > H ? TITLE_ANCHOR.landscape : W < H ? TITLE_ANCHOR.vertical : TITLE_ANCHOR.square;
  const baseline = m.baseline * fontPx;

  const xLeft = -halfW + margin;                 // left text edge at margin
  const xRight = halfW - margin;                 // right text edge at margin
  const yTopFirst = halfH - margin - m.topGap * s - halfLine;     // first line = top outer line
  const captionBottomShift = style === 'caption'
    ? m.captionFixCoeff * (TITLE_FONT_PX.subtitle - TITLE_FONT_PX.caption) * s
    : 0;
  const yBottomFirst = -halfH + margin + m.bottomGap * s + halfLine + (lineCount - 1) * lineStep + captionBottomShift;
  const yCenterFirst = baseline + (lineCount - 1) / 2 * lineStep;  // first line above block center

  let sx = 0, sy = 0;
  let alignment: 'left' | 'center' | 'right' = 'center';
  switch (position) {
    case 'top-left':      sx = xLeft;  sy = yTopFirst;    alignment = 'left';  break;
    case 'top-right':     sx = xRight; sy = yTopFirst;    alignment = 'right'; break;
    case 'bottom-left':   sx = xLeft;  sy = yBottomFirst; alignment = 'left';  break;
    case 'bottom-center': sx = 0;      sy = yBottomFirst; alignment = 'center'; break;
    case 'bottom-right':  sx = xRight; sy = yBottomFirst; alignment = 'right'; break;
    case 'center':        sx = 0;      sy = yCenterFirst; alignment = 'center'; break;
  }

  const u = H / 100; // px per transform unit
  return { tx: sx / u, ty: sy / u, alignment };
}

export function makeTitleXml(
  text: string,
  tsId: string,
  offset: string,
  duration: string,
  indent: string,
  effectRef: string,
  position: string,
  style: 'title' | 'subtitle' | 'caption',
  layout: TitleLayout,
  lane: number = 1,
  animation?: ResolvedOverlay['animation'],
  durationSeconds: number = 0,
  fps: number = 50,
): string {
  const lineCount = text.split('\n').length;

  // Narrow-frame sizing (scaleMode): in vertical/square sequences the Essential
  // Titles' 1920×1080 canvas is conformed into the frame, and under that conform
  // FCP ignores the generated text-style fontSize, rendering every title at the
  // template's default size. So we can't size via fontSize here — we render at a
  // fixed base fontSize and shrink the whole title with <adjust-transform scale>
  // (subtitle/caption scale down from the title). The two templates have
  // DIFFERENT default sizes under conform (a side effect of their differing
  // animation-rig rest states), so they need different bases:
  //  - Essential Title (static/slide/pop): render at TITLE_SCALE_BASE_FONTSIZE
  //    and shrink by the measured aspectScale (× style ratio).
  //  - Essential Fade: its default sits ~at the title size → render at the
  //    title's own fontSize and shrink by the pure style ratio. The fade title is
  //    unchanged (ratio 1); fade subtitle/caption, which would otherwise render
  //    too big, hit target.
  // Landscape (canvas matches the frame, no conform) sizes directly via fontSize.
  const isFade = animation?.type === 'fade';
  const useScaleBase = layout.scaleMode && !isFade;
  const useFadeScale = layout.scaleMode && isFade;
  const { tx, ty, alignment } = titleTransformPos(position, style, lineCount, layout);
  let fontSize: number, titleScale: number;
  if (useScaleBase) {
    fontSize = TITLE_SCALE_BASE_FONTSIZE;
    titleScale = layout.aspectScale * TITLE_FONT_PX[style] / TITLE_FONT_PX.title;
  } else if (useFadeScale) {
    fontSize = Math.round(TITLE_FONT_PX.title * layout.fontScale);
    titleScale = TITLE_FONT_PX[style] / TITLE_FONT_PX.title;
  } else {
    fontSize = Math.round(TITLE_FONT_PX[style] * layout.fontScale);
    titleScale = 1;
  }
  const boldAttr = style === 'title' ? ' bold="1"' : '';
  const shadowOffset = Math.max(1, Math.round(fontSize * 0.025));
  const shadowBlur = Math.max(1, Math.round(fontSize * 0.1));
  const shadowAttrs = ` shadowColor="0 0 0 0.8" shadowOffset="${shadowOffset} ${shadowOffset}" shadowBlurRadius="${shadowBlur}"`;
  const scaleAttr = titleScale !== 1 ? ` scale="${round4(titleScale)} ${round4(titleScale)}"` : '';
  const I4 = `${indent}    `;

  // Position/scale live in <adjust-transform>, which per the DTD must come AFTER
  // text / text-style-def inside <title>. Slide animates the transform position.
  const transformXml = animation?.type === 'slide' && durationSeconds > 0
    ? makeSlideTransformXml(animation, position, style, lineCount, tx, ty, scaleAttr, durationSeconds, fps, I4, layout)
    : `${I4}<adjust-transform position="${round4(tx)} ${round4(ty)}"${scaleAttr} />`;

  return [
    `${indent}<title ref="${effectRef}" lane="${lane}" name="${fcpName(text)}" offset="${offset}" duration="${duration}" start="0/1s">`,
    `${I4}<text>`,
    `${I4}    <text-style ref="${tsId}" alignment="${alignment}">${escapeXml(text)}</text-style>`,
    `${I4}</text>`,
    `${I4}<text-style-def id="${tsId}">`,
    `${I4}    <text-style font="Helvetica Neue" fontSize="${fontSize}" fontFace="Regular" fontColor="1 1 1 1"${boldAttr} alignment="${alignment}"${shadowAttrs} />`,
    `${I4}</text-style-def>`,
    transformXml,
    `${indent}</title>`,
  ].join('\n');
}

function makeSlideTransformXml(
  animation: NonNullable<ResolvedOverlay['animation']>,
  position: string,
  style: 'title' | 'subtitle' | 'caption',
  lineCount: number,
  tx: number,
  ty: number,
  scaleAttr: string,
  durationSeconds: number,
  fps: number,
  indent: string,
  layout: TitleLayout,
): string {
  const animDur = Math.min(animation.durationSeconds, durationSeconds / 3);
  if (animDur < 0.01) return `${indent}<adjust-transform position="${round4(tx)} ${round4(ty)}"${scaleAttr} />`;

  // Off-screen start/end: top positions slide in from above, others from below.
  // Half-height edge is 50 transform units; push past it by the text half-height.
  const s = layout.shortEdge / 1080;
  const halfTextHUnits = (lineCount * TITLE_FONT_PX[style] * s * LINE_HEIGHT / 2) * 100 / layout.height;
  const isTop = position.startsWith('top');
  const exit = 50 + halfTextHUnits + 3;
  const tyOff = isTop ? exit : -exit;

  const animDurRat = toRational(animDur, fps);
  const endStartRat = toRational(durationSeconds - animDur, fps);
  const durationRat = toRational(durationSeconds, fps);
  const I = indent, x = round4(tx), on = round4(ty), off = round4(tyOff);
  return [
    `${I}<adjust-transform${scaleAttr}>`,
    `${I}    <param name="position">`,
    `${I}        <keyframeAnimation>`,
    `${I}            <keyframe time="0/1s" value="${x} ${off}" interp="linear"/>`,
    `${I}            <keyframe time="${animDurRat}" value="${x} ${on}"/>`,
    `${I}            <keyframe time="${endStartRat}" value="${x} ${on}" interp="linear"/>`,
    `${I}            <keyframe time="${durationRat}" value="${x} ${off}"/>`,
    `${I}        </keyframeAnimation>`,
    `${I}    </param>`,
    `${I}</adjust-transform>`,
  ].join('\n');
}

// Resource ids for the three title templates (null when that template is unused).
// generate.ts allocates these (interleaved with transition/format ids) and passes
// them back to titleEffectRef / titleEffectLines.
export interface TitleEffectIds {
  essentialId: string | null;
  fadeId: string | null;
  scaleId: string | null;
}

// Which title templates the overlays require: Essential Title (no animation /
// slide), Essential Fade (fade), Essential Scale (pop).
export function titleEffectsNeeded(overlays: ResolvedOverlay[]): { essential: boolean; fade: boolean; scale: boolean } {
  return {
    essential: overlays.some(o => !o.animation || o.animation.type === 'slide'),
    fade: overlays.some(o => o.animation?.type === 'fade'),
    scale: overlays.some(o => o.animation?.type === 'pop'),
  };
}

// Pick the template ref for one overlay: fade→Essential Fade, pop→Essential Scale,
// else Essential Title. (DaVinci ignores titles; they render at center there.)
export function titleEffectRef(overlay: ResolvedOverlay, ids: TitleEffectIds): string {
  if (overlay.animation?.type === 'fade') return ids.fadeId!;
  if (overlay.animation?.type === 'pop') return ids.scaleId!;
  return ids.essentialId!;
}

// The <effect> resource lines for whichever title templates are in use.
export function titleEffectLines(ids: TitleEffectIds): string[] {
  const lines: string[] = [];
  if (ids.essentialId) lines.push(`        <effect id="${ids.essentialId}" name="Essential Title" uid="${TITLE_EFFECT_UID}" />`);
  if (ids.fadeId) lines.push(`        <effect id="${ids.fadeId}" name="Essential Fade" uid="${TITLE_FADE_UID}" />`);
  if (ids.scaleId) lines.push(`        <effect id="${ids.scaleId}" name="Essential Scale" uid="${TITLE_SCALE_UID}" />`);
  return lines;
}
