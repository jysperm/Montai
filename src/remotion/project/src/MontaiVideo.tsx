import React, { useCallback } from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from 'remotion';
import { Video } from '@remotion/media';
import { TransitionSeries, linearTiming, type TransitionPresentation } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';

interface CropValues {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface EditClip {
  clipId: string;
  videoId: number;
  sourceFile: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  playbackRate: number;
  volume: number;
  transition: { type: string; durationSeconds: number; direction?: string };
  crop?: CropValues;
  cropEnd?: CropValues;
}

interface OverlayAnimation {
  type: 'fade' | 'slide' | 'pop';
  durationSeconds: number;
}

interface TextOverlay {
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  position: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  style: 'title' | 'subtitle' | 'caption';
  animation?: OverlayAnimation;
}

interface AudioTrack {
  sourceFile: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  audioStartSeconds: number;
  volume: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

export interface TimelineProps {
  [key: string]: unknown;
  name: string;
  fps: number;
  width: number;
  height: number;
  clips: EditClip[];
  textOverlays: TextOverlay[];
  audioTracks?: AudioTrack[];
  voiceoverTracks?: AudioTrack[];
}

function getPositionStyle(position: TextOverlay['position'], s: number) {
  const margin = Math.round(40 * s);
  switch (position) {
    case 'top-left': return { top: margin, left: margin, textAlign: 'left' as const };
    case 'top-right': return { top: margin, right: margin, textAlign: 'right' as const };
    case 'center': return { top: '50%' as const, left: 0, right: 0, transform: 'translateY(-50%)', textAlign: 'center' as const };
    case 'bottom-left': return { bottom: margin, left: margin, textAlign: 'left' as const };
    case 'bottom-center': return { bottom: margin, left: 0, right: 0, textAlign: 'center' as const };
    case 'bottom-right': return { bottom: margin, right: margin, textAlign: 'right' as const };
  }
}

function getTextStyle(style: TextOverlay['style'], s: number) {
  const textShadow = `0 ${Math.round(2 * s)}px ${Math.round(8 * s)}px rgba(0,0,0,0.8), 0 0 ${Math.round(2 * s)}px rgba(0,0,0,0.9)`;
  switch (style) {
    case 'title': return { fontSize: Math.round(80 * s), fontWeight: 'bold' as const, textShadow };
    case 'subtitle': return { fontSize: Math.round(48 * s), fontWeight: 500 as const, textShadow };
    case 'caption': return {
      fontSize: Math.round(32 * s),
      fontWeight: 'normal' as const,
      background: 'rgba(0,0,0,0.6)',
      padding: `${Math.round(4 * s)}px ${Math.round(12 * s)}px`,
      borderRadius: Math.round(4 * s),
      display: 'inline-block' as const,
    };
  }
}

function OverlayContent({
  overlay,
  scale,
  fps,
  durationFrames,
}: {
  overlay: TextOverlay;
  scale: number;
  fps: number;
  durationFrames: number;
}) {
  const frame = useCurrentFrame();
  const pos = getPositionStyle(overlay.position, scale);
  const textStyle = getTextStyle(overlay.style, scale);

  const anim = overlay.animation;
  const animFrames = anim
    ? Math.min(Math.round(anim.durationSeconds * fps), Math.floor(durationFrames / 3))
    : 0;

  let opacity = 1;
  let extraTransform = '';

  if (anim && animFrames > 0) {
    const enterEnd = animFrames;
    const exitStart = durationFrames - animFrames;

    if (anim.type === 'fade') {
      opacity = interpolate(frame, [0, enterEnd, exitStart, durationFrames], [0, 1, 1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    } else if (anim.type === 'slide') {
      const slideDistance = Math.round(150 * scale);
      const isTop = overlay.position.startsWith('top');
      const direction = isTop ? -1 : 1;

      // Positional motion only — no opacity fade. Text starts off-screen and slides in,
      // so opacity isn't needed and combining it would halve the visible animation duration.
      const slideOffset = interpolate(
        frame,
        [0, enterEnd, exitStart, durationFrames],
        [slideDistance * direction, 0, 0, slideDistance * direction],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      );

      extraTransform = `translateY(${slideOffset}px)`;
    } else if (anim.type === 'pop') {
      const scaleVal = interpolate(
        frame,
        [0, enterEnd, exitStart, durationFrames],
        [0.7, 1, 1, 0.7],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      );

      opacity = interpolate(frame, [0, enterEnd, exitStart, durationFrames], [0, 1, 1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

      extraTransform = `scale(${scaleVal})`;
    }
  }

  const baseTransform = pos.transform ?? '';
  const combinedTransform = [baseTransform, extraTransform].filter(Boolean).join(' ') || undefined;

  return (
    <div
      style={{
        position: 'absolute',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        color: 'white',
        pointerEvents: 'none',
        ...pos,
        opacity,
        transform: combinedTransform,
      }}
    >
      <div style={{ ...textStyle, whiteSpace: 'pre-line' }}>{overlay.text}</div>
    </div>
  );
}

function getTransition(type: string, direction?: string): TransitionPresentation<Record<string, unknown>> | null {
  const dir = direction as
    | 'from-left'
    | 'from-right'
    | 'from-top'
    | 'from-bottom'
    | undefined;
  switch (type) {
    case 'fade':
      return fade() as TransitionPresentation<Record<string, unknown>>;
    case 'slide':
      return slide({ direction: dir }) as TransitionPresentation<Record<string, unknown>>;
    case 'wipe':
      return wipe({ direction: dir }) as TransitionPresentation<Record<string, unknown>>;
    default:
      return null;
  }
}

function cropToTransform(crop: CropValues, width: number, height: number) {
  // Crop values are percentages of original frame height.
  // visible fraction: e.g. left=10, right=10 on a 16:9 (1920×1080) frame
  // means 10% of height (108px) trimmed from each side.
  const aspectRatio = width / height;
  const visibleWidth = 1 - (crop.left + crop.right) / (100 * aspectRatio);
  const visibleHeight = 1 - (crop.top + crop.bottom) / 100;

  const scaleX = 1 / Math.max(visibleWidth, 0.01);
  const scaleY = 1 / Math.max(visibleHeight, 0.01);
  const scale = Math.max(scaleX, scaleY);

  // Translate to center the visible region (% of element size).
  // CSS `scale(S) translate(X%, Y%)` applies translate first, then scale,
  // so translate is independent of scale factor.
  const translateX = -(crop.left - crop.right) / (2 * aspectRatio);
  const translateY = -(crop.top - crop.bottom) / 2;

  return { scale, translateX, translateY };
}

function getSourcePath(sourceFile: string): string {
  const filename = sourceFile.split('/').pop() ?? sourceFile;
  return staticFile(filename);
}

function ClipVideo({
  clip,
  fps,
  width,
  height,
  incomingTransitionFrames,
  outgoingTransitionFrames,
}: {
  clip: EditClip;
  fps: number;
  width: number;
  height: number;
  incomingTransitionFrames: number;
  outgoingTransitionFrames: number;
}) {
  const frame = useCurrentFrame();
  const durationFrames = Math.round(
    ((clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate) * fps,
  );
  const hasTransitions = incomingTransitionFrames > 0 || outgoingTransitionFrames > 0;
  const hasCrop = !!(clip.crop || clip.cropEnd);

  const volumeCallback = useCallback(
    (frame: number) => {
      let vol = clip.volume;
      if (incomingTransitionFrames > 0 && frame < incomingTransitionFrames) {
        vol *= frame / incomingTransitionFrames;
      }
      if (outgoingTransitionFrames > 0 && frame > durationFrames - outgoingTransitionFrames) {
        vol *= (durationFrames - frame) / outgoingTransitionFrames;
      }
      return Math.max(0, vol);
    },
    [clip.volume, incomingTransitionFrames, outgoingTransitionFrames, durationFrames],
  );

  // Compute crop transform (static or Ken Burns animated)
  let cropTransform: { scale: number; translateX: number; translateY: number } | null = null;
  if (hasCrop) {
    const defaultCrop = { left: 0, top: 0, right: 0, bottom: 0 };
    const cropStart = clip.crop ?? defaultCrop;

    if (clip.cropEnd) {
      // Ken Burns: interpolate between start and end crop values
      const currentCrop = {
        left: interpolate(frame, [0, durationFrames], [cropStart.left, clip.cropEnd.left], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        top: interpolate(frame, [0, durationFrames], [cropStart.top, clip.cropEnd.top], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        right: interpolate(frame, [0, durationFrames], [cropStart.right, clip.cropEnd.right], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        bottom: interpolate(frame, [0, durationFrames], [cropStart.bottom, clip.cropEnd.bottom], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      };
      cropTransform = cropToTransform(currentCrop, width, height);
    } else {
      cropTransform = cropToTransform(cropStart, width, height);
    }
  }

  const video = (
    <Video
      src={getSourcePath(clip.sourceFile)}
      trimBefore={Math.round(clip.startTimeSeconds * fps)}
      volume={hasTransitions ? volumeCallback : clip.volume}
      playbackRate={clip.playbackRate}
      style={cropTransform
        ? { width: '100%', height: '100%', transform: `scale(${cropTransform.scale}) translate(${cropTransform.translateX}%, ${cropTransform.translateY}%)` }
        : { width: '100%', height: '100%' }
      }
    />
  );

  if (cropTransform) {
    return (
      <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        {video}
      </div>
    );
  }

  return video;
}

export function calculateTotalFrames(spec: TimelineProps): number {
  let total = 0;
  const { fps } = spec;

  for (let i = 0; i < spec.clips.length; i++) {
    const clip = spec.clips[i];
    const clipDuration =
      (clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate;
    total += Math.round(clipDuration * fps);
    if (i > 0 && clip.transition) {
      const transitionFrames = Math.round(clip.transition.durationSeconds * fps);
      if (clip.transition?.type && transitionFrames > 0) {
        total -= transitionFrames;
      }
    }
  }

  return Math.max(total, 1);
}

function AudioTrackComponent({ track, fps }: { track: AudioTrack; fps: number }) {
  const startFrame = Math.round(track.startTimeSeconds * fps);
  const durationFrames = Math.round(
    (track.endTimeSeconds - track.startTimeSeconds) * fps,
  );
  const startFromFrame = Math.round(track.audioStartSeconds * fps);
  const fadeInFrames = Math.round(track.fadeInSeconds * fps);
  const fadeOutFrames = Math.round(track.fadeOutSeconds * fps);
  const baseVolume = track.volume;

  const volumeCallback = useCallback(
    (frame: number) => {
      let vol = baseVolume;
      // Fade in
      if (fadeInFrames > 0 && frame < fadeInFrames) {
        vol *= frame / fadeInFrames;
      }
      // Fade out
      if (fadeOutFrames > 0 && frame > durationFrames - fadeOutFrames) {
        vol *= (durationFrames - frame) / fadeOutFrames;
      }
      return Math.max(0, vol);
    },
    [baseVolume, fadeInFrames, fadeOutFrames, durationFrames],
  );

  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <Audio
        src={getSourcePath(track.sourceFile)}
        startFrom={startFromFrame}
        volume={volumeCallback}
      />
    </Sequence>
  );
}

export const MontaiVideo: React.FC<TimelineProps> = (props) => {
  const { fps, width, height, clips, textOverlays, audioTracks, voiceoverTracks } = props;
  const scale = height / 1080;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <TransitionSeries>
        {clips.map((clip, clipIndex) => {
          const durationFrames = Math.round(
            ((clip.endTimeSeconds - clip.startTimeSeconds) /
              clip.playbackRate) *
              fps,
          );
          const transition = clip.transition
            ? getTransition(clip.transition.type, clip.transition.direction)
            : null;
          const transitionFrames = clip.transition
            ? Math.round(clip.transition.durationSeconds * fps)
            : 0;
          const nextClip = clips[clipIndex + 1];
          const outgoingTransitionFrames = nextClip?.transition
            ? Math.round(nextClip.transition.durationSeconds * fps)
            : 0;

          return [
            clipIndex > 0 && transition && transitionFrames > 0 ? (
              <TransitionSeries.Transition
                key={`transition-${clip.clipId}`}
                presentation={transition}
                timing={linearTiming({ durationInFrames: transitionFrames })}
              />
            ) : null,
            <TransitionSeries.Sequence
              key={clip.clipId}
              durationInFrames={durationFrames}
            >
              <ClipVideo
                clip={clip}
                fps={fps}
                width={width}
                height={height}
                incomingTransitionFrames={transitionFrames}
                outgoingTransitionFrames={outgoingTransitionFrames}
              />
            </TransitionSeries.Sequence>,
          ].filter(Boolean);
        })}
      </TransitionSeries>

      {textOverlays.map((overlay, i) => {
        const startFrame = Math.round(overlay.startTimeSeconds * fps);
        const durationFrames = Math.round(
          (overlay.endTimeSeconds - overlay.startTimeSeconds) * fps,
        );

        return (
          <Sequence key={i} from={startFrame} durationInFrames={durationFrames}>
            <OverlayContent
              overlay={overlay}
              scale={scale}
              fps={fps}
              durationFrames={durationFrames}
            />
          </Sequence>
        );
      })}

      {(audioTracks ?? []).map((track, i) => (
        <AudioTrackComponent key={`audio-${i}`} track={track} fps={fps} />
      ))}

      {(voiceoverTracks ?? []).map((track, i) => (
        <AudioTrackComponent key={`voiceover-${i}`} track={track} fps={fps} />
      ))}
    </AbsoluteFill>
  );
};
