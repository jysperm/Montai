import React from 'react';
import { AbsoluteFill, Audio, Composition, registerRoot, staticFile, useCurrentFrame } from 'remotion';

const FPS = 30;
const DURATION_SECONDS = 30;
const EDGE_SIZE = 34;
const GRADIENT_CYCLES = 4.5;
const GRID_CELLS = 10;

type PatternProps = {
  label: string;
  logicalWidth: number;
  logicalHeight: number;
};

function EdgeLabel({ text, x, y, rotation = 0 }: { text: string; x: number; y: number; rotation?: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontWeight: 800,
        fontSize: 46,
        color: 'white',
        textShadow: '0 3px 8px rgba(0,0,0,0.9)',
      }}
    >
      {text}
    </div>
  );
}

function CenterLabel({ text, x, y, fontSize }: { text: string; x: number; y: number; fontSize: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontWeight: 900,
        fontSize,
        color: 'white',
        lineHeight: 1,
        textAlign: 'center',
        textShadow: '0 5px 12px rgba(0,0,0,0.95)',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

function TestPattern({ label, logicalWidth, logicalHeight }: PatternProps) {
  const frame = useCurrentFrame();
  const seconds = frame / FPS;
  const totalFrames = DURATION_SECONDS * FPS;
  const gridLineIndexes = Array.from({ length: GRID_CELLS - 1 }, (_, index) => index + 1);
  const gradientPhase = (frame / (DURATION_SECONDS * FPS)) * Math.PI * 2 * GRADIENT_CYCLES;
  const gradientX1 = 32 + Math.sin(gradientPhase) * 20;
  const gradientY1 = 28 + Math.cos(gradientPhase * 0.8) * 18;
  const gradientX2 = 70 + Math.sin(gradientPhase * 0.7 + 1.8) * 22;
  const gradientY2 = 38 + Math.cos(gradientPhase * 0.9 + 1.2) * 20;
  const gradientX3 = 48 + Math.sin(gradientPhase * 0.6 + 3.2) * 24;
  const gradientY3 = 76 + Math.cos(gradientPhase * 0.75 + 2.6) * 16;
  const hueShift = Math.sin(gradientPhase * 0.55) * 34;
  const shortEdge = Math.min(logicalWidth, logicalHeight);
  const mainLabel = `${label} ${logicalWidth}x${logicalHeight}`;
  const textFontSize = Math.min(
    Math.round(shortEdge * 0.065),
    Math.floor((logicalWidth * 0.86) / (mainLabel.length * 0.72)),
  );
  const arrowSide = Math.round(shortEdge * 0.16);
  const arrowHeight = arrowSide * Math.sqrt(3) / 2;

  return (
    <AbsoluteFill
      style={{
        background: `
          radial-gradient(circle at ${gradientX1}% ${gradientY1}%, hsla(${206 + hueShift}, 88%, 45%, 0.75), transparent 46%),
          radial-gradient(circle at ${gradientX2}% ${gradientY2}%, hsla(${318 - hueShift * 0.6}, 84%, 48%, 0.72), transparent 48%),
          radial-gradient(circle at ${gradientX3}% ${gradientY3}%, hsla(${158 + hueShift * 0.8}, 78%, 42%, 0.68), transparent 50%),
          linear-gradient(135deg, #121b52 0%, #4b126b 48%, #053f4d 100%)
        `,
        overflow: 'hidden',
      }}
    >
      {gridLineIndexes.map(index => (
        <React.Fragment key={index}>
          <div
            style={{
              position: 'absolute',
              left: `${(index / GRID_CELLS) * 100}%`,
              top: 0,
              bottom: 0,
              width: 2,
              backgroundColor: 'rgba(255,255,255,0.16)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: `${(index / GRID_CELLS) * 100}%`,
              left: 0,
              right: 0,
              height: 2,
              backgroundColor: 'rgba(255,255,255,0.16)',
            }}
          />
        </React.Fragment>
      ))}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: EDGE_SIZE, backgroundColor: '#ff3b30' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: EDGE_SIZE, backgroundColor: '#34c759' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: EDGE_SIZE, backgroundColor: '#007aff' }} />
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: EDGE_SIZE, backgroundColor: '#ffd60a' }} />
      <div style={{ position: 'absolute', top: 0, left: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#ff3b30', clipPath: 'polygon(0 0, 100% 0, 100% 100%)' }} />
      <div style={{ position: 'absolute', top: 0, left: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#ffd60a', clipPath: 'polygon(0 0, 0 100%, 100% 100%)' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#ff3b30', clipPath: 'polygon(0 0, 100% 0, 0 100%)' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#34c759', clipPath: 'polygon(100% 0, 0 100%, 100% 100%)' }} />
      <div style={{ position: 'absolute', right: 0, bottom: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#007aff', clipPath: 'polygon(0 0, 0 100%, 100% 100%)' }} />
      <div style={{ position: 'absolute', right: 0, bottom: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#34c759', clipPath: 'polygon(0 0, 100% 0, 100% 100%)' }} />
      <div style={{ position: 'absolute', left: 0, bottom: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#ffd60a', clipPath: 'polygon(0 0, 100% 0, 0 100%)' }} />
      <div style={{ position: 'absolute', left: 0, bottom: 0, width: EDGE_SIZE, height: EDGE_SIZE, backgroundColor: '#007aff', clipPath: 'polygon(100% 0, 0 100%, 100% 100%)' }} />
      <div
        style={{
          position: 'absolute',
          left: logicalWidth / 2 - 3,
          top: 80,
          bottom: 80,
          width: 6,
          backgroundColor: 'rgba(255,255,255,0.7)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: logicalHeight / 2 - 3,
          left: 80,
          right: 80,
          height: 6,
          backgroundColor: 'rgba(255,255,255,0.7)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: logicalWidth / 2 - arrowSide / 2,
          top: logicalHeight / 2 - arrowHeight * 2 / 3,
          width: 0,
          height: 0,
          borderLeft: `${arrowSide / 2}px solid transparent`,
          borderRight: `${arrowSide / 2}px solid transparent`,
          borderBottom: `${arrowHeight}px solid white`,
          filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.65))',
        }}
      />
      <CenterLabel
        text={mainLabel}
        x={logicalWidth / 2}
        y={logicalHeight / 2 - shortEdge * 0.31}
        fontSize={textFontSize}
      />
      <CenterLabel
        text={`${seconds.toFixed(1)}s (${frame}/${totalFrames})`}
        x={logicalWidth / 2}
        y={logicalHeight / 2 - shortEdge * 0.22}
        fontSize={textFontSize}
      />
      <EdgeLabel text="TOP" x={logicalWidth / 2} y={92} />
      <EdgeLabel text="RIGHT" x={logicalWidth - 92} y={logicalHeight / 2} rotation={90} />
      <EdgeLabel text="BOTTOM" x={logicalWidth / 2} y={logicalHeight - 92} rotation={180} />
      <EdgeLabel text="LEFT" x={92} y={logicalHeight / 2} rotation={-90} />
    </AbsoluteFill>
  );
}

function PatternFrame({ label, logicalWidth, logicalHeight, rotate = 0 }: PatternProps & { rotate?: number }) {
  return (
    <AbsoluteFill style={{ backgroundColor: '#050608', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: logicalWidth,
          height: logicalHeight,
          transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
          transformOrigin: 'center center',
        }}
      >
        <TestPattern label={label} logicalWidth={logicalWidth} logicalHeight={logicalHeight} />
      </div>
      <Audio src={staticFile('beep.wav')} volume={1} />
    </AbsoluteFill>
  );
}

function Root() {
  return (
    <>
      <Composition
        id="landscape"
        component={() => <PatternFrame label="LANDSCAPE" logicalWidth={1920} logicalHeight={1080} />}
        durationInFrames={DURATION_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="portrait"
        component={() => <PatternFrame label="PORTRAIT" logicalWidth={1080} logicalHeight={1920} />}
        durationInFrames={DURATION_SECONDS * FPS}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Composition
        id="portrait-misoriented"
        component={() => <PatternFrame label="PORTRAIT MISORIENTED" logicalWidth={1080} logicalHeight={1920} rotate={-90} />}
        durationInFrames={DURATION_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="landscape-misoriented"
        component={() => <PatternFrame label="LANDSCAPE MISORIENTED" logicalWidth={1920} logicalHeight={1080} rotate={-90} />}
        durationInFrames={DURATION_SECONDS * FPS}
        fps={FPS}
        width={1080}
        height={1920}
      />
    </>
  );
}

registerRoot(Root);
