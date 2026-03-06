import React from 'react';
import { AbsoluteFill, Sequence, staticFile, Video } from 'remotion';
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
  position: 'top' | 'center' | 'bottom';
  style: 'title' | 'subtitle' | 'caption';
}

export interface TimelineProps {
  [key: string]: unknown;
  name: string;
  fps: number;
  width: number;
  height: number;
  clips: EditClip[];
  textOverlays: TextOverlay[];
}

const positionStyles = {
  top: { top: 40, bottom: 'auto' as const },
  center: { top: '50%' as const, transform: 'translateY(-50%)' },
  bottom: { bottom: 40, top: 'auto' as const },
} as const;

const textStyles = {
  title: { fontSize: 64, fontWeight: 'bold' as const },
  subtitle: { fontSize: 36, fontWeight: 'normal' as const },
  caption: {
    fontSize: 24,
    fontWeight: 'normal' as const,
    background: 'rgba(0,0,0,0.6)',
    padding: '4px 12px',
    borderRadius: 4,
  },
} as const;

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

export function calculateTotalFrames(spec: TimelineProps): number {
  let total = 0;
  const { fps } = spec;

  for (const clip of spec.clips) {
    const clipDuration =
      (clip.endTimeSeconds - clip.startTimeSeconds) / clip.playbackRate;
    total += Math.round(clipDuration * fps);
    if (clip.transition) {
      const transitionFrames = Math.round(clip.transition.durationSeconds * fps);
      if (clip.transition.type !== 'none' && transitionFrames > 0) {
        total -= transitionFrames;
      }
    }
  }

  return Math.max(total, 1);
}

export const MontaiVideo: React.FC<TimelineProps> = (props) => {
  const { fps, clips, textOverlays } = props;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <TransitionSeries>
        {clips.map((clip) => {
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
              <Video
                src={getSourcePath(clip.sourceFile)}
                startFrom={Math.round(clip.startTimeSeconds * fps)}
                volume={clip.volume}
                playbackRate={clip.playbackRate}
                style={{ width: '100%', height: '100%' }}
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
        const pos = positionStyles[overlay.position];
        const style = textStyles[overlay.style];

        return (
          <Sequence key={i} from={startFrame} durationInFrames={durationFrames}>
            <AbsoluteFill
              style={{
                display: 'flex',
                justifyContent: 'center',
                position: 'absolute',
                ...pos,
                left: 0,
                right: 0,
                color: 'white',
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              <div style={{ ...style }}>{overlay.text}</div>
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
