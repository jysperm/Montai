import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
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

export interface EditSpecProps {
  name: string;
  fps: number;
  width: number;
  height: number;
  clips: EditClip[];
  textOverlays: TextOverlay[];
  titleCard?: { text: string; subtitle?: string; durationSeconds: number };
  endCard?: { text: string; durationSeconds: number };
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

function getTransition(type: string, direction?: string) {
  const dir = direction as
    | 'from-left'
    | 'from-right'
    | 'from-top'
    | 'from-bottom'
    | undefined;
  switch (type) {
    case 'fade':
      return fade();
    case 'slide':
      return slide({ direction: dir });
    case 'wipe':
      return wipe({ direction: dir });
    default:
      return null;
  }
}

function getSourcePath(sourceFile: string): string {
  const filename = sourceFile.split('/').pop() ?? sourceFile;
  return staticFile(filename);
}

export function calculateTotalFrames(spec: EditSpecProps): number {
  let total = 0;
  const { fps } = spec;

  if (spec.titleCard) {
    total += Math.round(spec.titleCard.durationSeconds * fps);
  }

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

  if (spec.endCard) {
    total += Math.round(spec.endCard.durationSeconds * fps);
  }

  return Math.max(total, 1);
}

export const CutFlowVideo: React.FC<EditSpecProps> = (props) => {
  const { fps, clips, textOverlays, titleCard, endCard } = props;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <TransitionSeries>
        {titleCard && (
          <TransitionSeries.Sequence
            durationInFrames={Math.round(titleCard.durationSeconds * fps)}
          >
            <AbsoluteFill
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
              }}
            >
              <div style={{ fontSize: 72, fontWeight: 'bold' }}>
                {titleCard.text}
              </div>
              {titleCard.subtitle && (
                <div style={{ fontSize: 36, marginTop: 16, opacity: 0.8 }}>
                  {titleCard.subtitle}
                </div>
              )}
            </AbsoluteFill>
          </TransitionSeries.Sequence>
        )}

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
              <OffthreadVideo
                src={getSourcePath(clip.sourceFile)}
                startFrom={Math.round(clip.startTimeSeconds * fps)}
                endAt={Math.round(clip.endTimeSeconds * fps)}
                volume={clip.volume}
                playbackRate={clip.playbackRate}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </TransitionSeries.Sequence>,
          ].filter(Boolean);
        })}

        {endCard && (
          <>
            <TransitionSeries.Transition
              presentation={fade()}
              timing={linearTiming({ durationInFrames: 15 })}
            />
            <TransitionSeries.Sequence
              durationInFrames={Math.round(endCard.durationSeconds * fps)}
            >
              <AbsoluteFill
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                }}
              >
                <div style={{ fontSize: 48 }}>{endCard.text}</div>
              </AbsoluteFill>
            </TransitionSeries.Sequence>
          </>
        )}
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
