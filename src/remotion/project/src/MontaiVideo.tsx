import React, { useCallback } from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { Video } from '@remotion/media';
import { TransitionSeries, linearTiming, type TransitionPresentation } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';

interface EditClip {
  clipId: string;
  videoId: number;
  sourceFile: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  playbackRate: number;
  volume: number;
  transition: { type: string; durationSeconds: number; direction?: string };
}

interface TextOverlay {
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  position: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  style: 'title' | 'subtitle' | 'caption';
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
    };
  }
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

function getSourcePath(sourceFile: string): string {
  const filename = sourceFile.split('/').pop() ?? sourceFile;
  return staticFile(filename);
}

function ClipVideo({
  clip,
  fps,
  incomingTransitionFrames,
  outgoingTransitionFrames,
}: {
  clip: EditClip;
  fps: number;
  incomingTransitionFrames: number;
  outgoingTransitionFrames: number;
}) {
  const durationFrames = Math.round(
    ((clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate) * fps,
  );
  const hasTransitions = incomingTransitionFrames > 0 || outgoingTransitionFrames > 0;

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

  return (
    <Video
      src={getSourcePath(clip.sourceFile)}
      trimBefore={Math.round(clip.startTimeSeconds * fps)}
      volume={hasTransitions ? volumeCallback : clip.volume}
      playbackRate={clip.playbackRate}
      style={{ width: '100%', height: '100%' }}
    />
  );
}

export function calculateTotalFrames(spec: TimelineProps): number {
  let total = 0;
  const { fps } = spec;

  for (const clip of spec.clips) {
    const clipDuration =
      (clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate;
    total += Math.round(clipDuration * fps);
    if (clip.transition) {
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
  const { fps, height, clips, textOverlays, audioTracks } = props;
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
            transition && transitionFrames > 0 ? (
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
        const pos = getPositionStyle(overlay.position, scale);
        const style = getTextStyle(overlay.style, scale);

        return (
          <Sequence key={i} from={startFrame} durationInFrames={durationFrames}>
            <div
              style={{
                position: 'absolute',
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                color: 'white',
                pointerEvents: 'none',
                ...pos,
              }}
            >
              <div style={{ ...style, whiteSpace: 'pre-line' }}>{overlay.text}</div>
            </div>
          </Sequence>
        );
      })}

      {(audioTracks ?? []).map((track, i) => (
        <AudioTrackComponent key={`audio-${i}`} track={track} fps={fps} />
      ))}
    </AbsoluteFill>
  );
};
