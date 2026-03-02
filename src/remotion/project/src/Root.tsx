import type { AnyZodObject } from 'zod';
import { Composition, staticFile } from 'remotion';
import { MontaiVideo, calculateTotalFrames, type TimelineProps } from './MontaiVideo';

export const RemotionRoot = () => {
  return (
    <Composition<AnyZodObject, TimelineProps>
      id="Montai"
      component={MontaiVideo}
      // Placeholders required by Remotion; overridden by calculateMetadata at runtime
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        name: '',
        fps: 30,
        width: 1920,
        height: 1080,
        clips: [],
        textOverlays: [],
      }}
      calculateMetadata={async ({ props }) => {
        let spec = props;

        // Studio mode fallback: fetch timeline from public dir when no props provided
        if (!spec.clips || spec.clips.length === 0) {
          const res = await fetch(staticFile('timeline.json'));
          spec = await res.json();
        }

        return {
          props: spec,
          durationInFrames: calculateTotalFrames(spec),
          fps: spec.fps,
          width: spec.width,
          height: spec.height,
        };
      }}
    />
  );
};
