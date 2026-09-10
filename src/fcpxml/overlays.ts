// Text-overlay rendering for the FCPXML exporter. Final Cut's built-in Subtitle
// template owns paragraph layout, wrapping, alignment, background and static
// placement. Intrinsic adjustments are reserved for the short overlay
// animations, so a positioned title is never rasterized and clipped first.

import type { ResolvedOverlay } from '../schemas/timeline.js';
import { escapeXml, fcpName, round4, toRational } from './utils.js';

const FONT_PX = { title: 80, subtitle: 48, caption: 32 } as const;
const SUBTITLE_UID = '.../Titles.localized/Subtitles.localized/Subtitle.localized/Subtitle.moti';
const TEMPLATE_HEIGHT = 2160;

// At the center detent Subtitle.moti writes these small, non-zero positions to
// the text object. Compensating them makes symmetric paragraph bounds actually
// land symmetrically on screen (the stock Y value otherwise leaves noticeably
// more room below bottom-aligned text).
const CENTER_X_OFFSET = 0.5014;
const CENTER_Y_OFFSET = 0.4931;
const FCP_CAPTION_BACKGROUND_OPACITY = 0.75;

// Published and text-object parameter keys from Apple's Subtitle.moti. The
// numeric key paths are stable across localized Final Cut installations.
const PARAM = {
  layout: '9999/3336674837/3336674846/2/314',
  left: '9999/3336674837/3336674846/2/323',
  right: '9999/3336674837/3336674846/2/324',
  top: '9999/3336674837/3336674846/2/325',
  bottom: '9999/3336674837/3336674846/2/326',
  anchor: '9999/3336674837/3336674846/2/357',
  autoShrink: '9999/3336674837/3336674846/2/370',
  alignment: '9999/3336674837/3336674846/2/373',
  anchorPosition: '9999/3336674837/3336674846/2/375',
  fontSize: '9999/3336674837/3336674846/5/3336674848/3',
  backgroundOpacity: '9999/3336674837/3336685305/3336678548/1/200/202',
  backgroundRadius: '9999/3336674837/3336685305/3336678548/2/353/144',
  backgroundWidth: '9999/3336678691/100/3336678692/2/100',
  backgroundHeight: '9999/3336678691/100/3336678786/2/100',
  animateBy: '9999/3336678691/100/3336679301/2/100',
  animationStyle: '9999/3336678691/100/3336692171/2/100',
  xOffset: '9999/3336678691/100/3337241478/2/100',
  yOffset: '9999/3336678691/100/3337241559/2/100',
  verticalSafe: '9999/3336678691/100/3337013104/2/100',
} as const;

export interface TitleLayout {
  width: number;
  height: number;
  shortEdge: number;
  target: 'fcp' | 'davinci';
}

type OverlayPosition = ResolvedOverlay['position'];
type OverlayStyle = ResolvedOverlay['style'];

export function buildTitleLayout(width: number, height: number, target: 'fcp' | 'davinci'): TitleLayout {
  return { width, height, shortEdge: Math.min(width, height), target };
}

type Alignment = 'left' | 'center' | 'right';
type VerticalAlignment = 'top' | 'center' | 'bottom';

function alignmentFor(position: OverlayPosition): { horizontal: Alignment; vertical: VerticalAlignment } {
  if (position === 'center') return { horizontal: 'center', vertical: 'center' };
  return {
    horizontal: position.endsWith('left') ? 'left' : position.endsWith('right') ? 'right' : 'center',
    vertical: position.startsWith('top') ? 'top' : 'bottom',
  };
}

function edgeMarginPx(style: OverlayStyle, layout: TitleLayout): number {
  return FONT_PX[style] * layout.shortEdge / 1080;
}

function paragraphBounds(
  layout: TitleLayout,
  style: OverlayStyle,
): { left: string; right: string; top: string; bottom: string } {
  // Motion's Subtitle canvas is scaled to the sequence height. A portrait
  // sequence therefore exposes a much narrower horizontal slice of the canvas.
  const unitsPerPixel = TEMPLATE_HEIGHT / layout.height;
  const margin = edgeMarginPx(style, layout);
  // Text glyphs sit about .25em inside Subtitle's paragraph line box. Pull the
  // top/bottom paragraph edge outward so the visible glyph edge, rather than
  // the invisible line box, lands one em from the frame. Caption uses its
  // visible background box and needs no font-metric correction.
  const verticalMargin = style === 'caption' ? margin : margin * 0.75;
  // Caption's position is measured from the outside of its background box.
  const padX = style === 'caption' ? 12 * layout.shortEdge / 1080 : 0;
  const padY = style === 'caption' ? 4 * layout.shortEdge / 1080 : 0;
  const halfWidth = layout.width * unitsPerPixel / 2;
  const halfHeight = layout.height * unitsPerPixel / 2;
  const x = halfWidth - (margin + padX) * unitsPerPixel;
  const y = halfHeight - (verticalMargin + padY) * unitsPerPixel;
  return { left: round4(-x), right: round4(x), top: round4(y), bottom: round4(-y) };
}

function captionGeometry(layout: TitleLayout): { width: string; height: string; radius: string } {
  const s = layout.shortEdge / 1080;
  const unitsPerPixel = TEMPLATE_HEIGHT / layout.height;
  // Motion's Align To Text offsets enlarge the total box dimension, hence 2×
  // the per-side CSS padding used by Remotion.
  const width = 2 * 12 * s * unitsPerPixel;
  const height = 2 * 4 * s * unitsPerPixel;
  const radius = 4 * s * unitsPerPixel;
  return {
    width: normalizedBackgroundPadding(width),
    height: normalizedBackgroundPadding(height),
    radius: round4(radius),
  };
}

// Subtitle.moti's unpublished aspect rig overwrites paragraph width and text
// scale. Values come from its 16:9, 1:1, and 9:16 snapshots, matching Montai's
// three supported output shapes.
function subtitleRig(layout: TitleLayout): { halfWidth: number | null; textScale: number } {
  if (layout.width < layout.height) return { halfWidth: 408, textScale: 0.8 };
  if (layout.width === layout.height) return { halfWidth: 840, textScale: 1 };
  return { halfWidth: null, textScale: 1.2 };
}

function horizontalPositionOffset(
  position: OverlayPosition,
  layout: TitleLayout,
  bounds: { left: string; right: string },
): number {
  const rigHalfWidth = subtitleRig(layout).halfWidth;
  if (rigHalfWidth === null || (!position.endsWith('left') && !position.endsWith('right'))) {
    return CENTER_X_OFFSET;
  }
  const desiredHalfWidth = Number(bounds.right);
  const outwardPoints = Math.max(0, desiredHalfWidth - rigHalfWidth);
  // The published widget maps 0…1 to -2000…2000 Motion points.
  const direction = position.endsWith('left') ? -1 : 1;
  return CENTER_X_OFFSET + direction * outwardPoints / 4000;
}

// Background Width/Height widgets serialize a -100…100 UI slider as 0…1.
// Its center snapshot produces 100 Motion points of padding; values below that
// interpolate from -1000 at 0 to 100 at .5.
function normalizedBackgroundPadding(points: number): string {
  if (points <= 100) return round4((points + 1000) / 2200);
  return round4(0.5 + (points - 100) / 1800);
}

function edgePivotPercent(position: OverlayPosition, layout: TitleLayout, style: OverlayStyle): [number, number] {
  const margin = edgeMarginPx(style, layout);
  const x = position.endsWith('left')
    ? -(layout.width / 2 - margin) * 100 / layout.height
    : position.endsWith('right') ? (layout.width / 2 - margin) * 100 / layout.height : 0;
  const y = position.startsWith('top')
    ? (layout.height / 2 - margin) * 100 / layout.height
    : position.startsWith('bottom') ? -(layout.height / 2 - margin) * 100 / layout.height : 0;
  return [x, y];
}

function animationDuration(animation: NonNullable<ResolvedOverlay['animation']>, durationSeconds: number): number {
  return Math.min(animation.durationSeconds, durationSeconds / 3);
}

function scalarKeyframes(
  values: [number, number, number, number],
  animation: NonNullable<ResolvedOverlay['animation']>,
  durationSeconds: number,
  fps: number,
  indent: string,
): string[] {
  const d = animationDuration(animation, durationSeconds);
  const times = [0, d, durationSeconds - d, durationSeconds];
  return times.map((time, i) =>
    `${indent}<keyframe time="${toRational(time, fps)}" value="${round4(values[i])}"/>`,
  );
}

function animationXml(
  animation: ResolvedOverlay['animation'],
  position: OverlayPosition,
  style: OverlayStyle,
  layout: TitleLayout,
  durationSeconds: number,
  fps: number,
  indent: string,
): string[] {
  if (!animation || animationDuration(animation, durationSeconds) < 0.01) return [];

  const lines: string[] = [];
  if (animation.type === 'slide') {
    const distancePx = 150 * layout.shortEdge / 1080;
    const direction = position.startsWith('top') ? 1 : -1; // FCP Y is positive upward
    const offset = distancePx * 100 / layout.height * direction;
    lines.push(
      `${indent}<adjust-transform>`,
      `${indent}    <param name="position">`,
      `${indent}        <keyframeAnimation>`,
      ...scalarKeyframes([offset, 0, 0, offset], animation, durationSeconds, fps, `${indent}            `)
        .map(line => line.replace(/ value="([^ ]+)"/, ' value="0 $1"')),
      `${indent}        </keyframeAnimation>`,
      `${indent}    </param>`,
      `${indent}</adjust-transform>`,
    );
  } else if (animation.type === 'pop') {
    const [pivotX, pivotY] = edgePivotPercent(position, layout, style);
    const d = animationDuration(animation, durationSeconds);
    const times = [0, d, durationSeconds - d, durationSeconds];
    const compensation = [0.3, 0, 0, 0.3];
    lines.push(
      `${indent}<adjust-transform>`,
      `${indent}    <param name="scale">`,
      `${indent}        <keyframeAnimation>`,
      ...scalarKeyframes([0.7, 1, 1, 0.7], animation, durationSeconds, fps, `${indent}            `)
        .map(line => line.replace(/ value="([^ ]+)"/, ' value="$1 $1"')),
      `${indent}        </keyframeAnimation>`,
      `${indent}    </param>`,
      `${indent}    <param name="position">`,
      `${indent}        <keyframeAnimation>`,
      ...times.map((time, i) =>
        `${indent}            <keyframe time="${toRational(time, fps)}" value="${round4(pivotX * compensation[i])} ${round4(pivotY * compensation[i])}"/>`,
      ),
      `${indent}        </keyframeAnimation>`,
      `${indent}    </param>`,
      `${indent}</adjust-transform>`,
    );
  }

  if (animation.type === 'fade' || animation.type === 'pop') {
    lines.push(
      `${indent}<adjust-blend>`,
      `${indent}    <param name="amount">`,
      `${indent}        <keyframeAnimation>`,
      ...scalarKeyframes([0, 1, 1, 0], animation, durationSeconds, fps, `${indent}            `),
      `${indent}        </keyframeAnimation>`,
      `${indent}    </param>`,
      `${indent}</adjust-blend>`,
    );
  }
  return lines;
}

export function makeTitleXml(
  text: string,
  tsId: string,
  offset: string,
  duration: string,
  indent: string,
  effectRef: string,
  position: OverlayPosition,
  style: OverlayStyle,
  layout: TitleLayout,
  lane: number = 1,
  animation?: ResolvedOverlay['animation'],
  durationSeconds: number = 0,
  fps: number = 50,
): string {
  const { horizontal, vertical } = alignmentFor(position);
  const bounds = paragraphBounds(layout, style);
  const caption = captionGeometry(layout);
  const xPositionOffset = horizontalPositionOffset(position, layout, bounds);
  // FCP scales the 2160-high Subtitle canvas to the sequence height, then its
  // hidden aspect rig applies another text-style scale. Compensate both so the
  // visual size still follows Montai's short-edge convention.
  const fcpFontScale = TEMPLATE_HEIGHT * layout.shortEdge / (1080 * layout.height);
  const numericFontSize = FONT_PX[style] * (layout.target === 'fcp'
    ? fcpFontScale / subtitleRig(layout).textScale
    : 1);
  const fontSize = round4(numericFontSize);
  const fontFace = style === 'title' ? 'Bold' : style === 'subtitle' ? 'Medium' : 'Regular';
  const shadowOffset = Math.max(1, Math.round(numericFontSize * 0.025));
  const shadowBlur = Math.max(1, Math.round(numericFontSize * 0.1));
  const shadowAttrs = style === 'caption'
    ? ''
    : ` shadowColor="0 0 0 0.8" shadowOffset="${shadowOffset} ${shadowOffset}" shadowBlurRadius="${shadowBlur}"`;
  const horizontalValue = horizontal === 'left' ? 0 : horizontal === 'center' ? 1 : 2;
  const verticalValue = vertical === 'top' ? 0 : vertical === 'center' ? 1 : 2;
  const I = `${indent}    `;

  const params = [
    `${I}<param name="Layout Method" key="${PARAM.layout}" value="1 (Paragraph)"/>`,
    `${I}<param name="Left Boundary" key="${PARAM.left}" value="${bounds.left}"/>`,
    `${I}<param name="Right Boundary" key="${PARAM.right}" value="${bounds.right}"/>`,
    `${I}<param name="Top Boundary" key="${PARAM.top}" value="${bounds.top}"/>`,
    `${I}<param name="Bottom Boundary" key="${PARAM.bottom}" value="${bounds.bottom}"/>`,
    `${I}<param name="Anchor" key="${PARAM.anchor}" value="1 (Word)"/>`,
    `${I}<param name="Auto Shrink" key="${PARAM.autoShrink}" value="3 (To All Bounds)"/>`,
    `${I}<param name="Alignment" key="${PARAM.alignment}" value="${horizontalValue} (${horizontal}) ${verticalValue} (${vertical})"/>`,
    `${I}<param name="Anchor Position" key="${PARAM.anchorPosition}" value="1 (Center)"/>`,
    `${I}<param name="Font Size" key="${PARAM.fontSize}" value="${fontSize}"/>`,
    `${I}<param name="Background Opacity" key="${PARAM.backgroundOpacity}" value="${style === 'caption' ? (layout.target === 'fcp' ? FCP_CAPTION_BACKGROUND_OPACITY : 0.6) : 0}"/>`,
    ...(style === 'caption'
      ? [
          `${I}<param name="Background Width" key="${PARAM.backgroundWidth}" value="${caption.width}"/>`,
          `${I}<param name="Background Height" key="${PARAM.backgroundHeight}" value="${caption.height}"/>`,
          `${I}<param name="Background Corner Radius" key="${PARAM.backgroundRadius}" value="${caption.radius}"/>`,
        ]
      : []),
    `${I}<param name="Animate By" key="${PARAM.animateBy}" value="3 (All)"/>`,
    `${I}<param name="Animation Style" key="${PARAM.animationStyle}" value="0 (None)"/>`,
    `${I}<param name="X Position Offset" key="${PARAM.xOffset}" value="${round4(xPositionOffset)}"/>`,
    `${I}<param name="Y Position Offset" key="${PARAM.yOffset}" value="${CENTER_Y_OFFSET}"/>`,
    ...(layout.width < layout.height
      ? [`${I}<param name="Vertical Social Media Safe" key="${PARAM.verticalSafe}" value="0"/>`]
      : []),
  ];

  return [
    `${indent}<title ref="${effectRef}" lane="${lane}" name="${fcpName(text)}" offset="${offset}" duration="${duration}" start="0/1s">`,
    ...params,
    `${I}<text>`,
    `${I}    <text-style ref="${tsId}" alignment="${horizontal}">${escapeXml(text)}</text-style>`,
    `${I}</text>`,
    `${I}<text-style-def id="${tsId}">`,
    `${I}    <text-style font="Helvetica Neue" fontSize="${fontSize}" fontFace="${fontFace}" fontColor="1 1 1 1" alignment="${horizontal}"${shadowAttrs}/>`,
    `${I}</text-style-def>`,
    ...animationXml(animation, position, style, layout, durationSeconds, fps, I),
    `${indent}</title>`,
  ].join('\n');
}

export function subtitleEffectLine(id: string): string {
  return `        <effect id="${id}" name="Subtitle" uid="${SUBTITLE_UID}" />`;
}
