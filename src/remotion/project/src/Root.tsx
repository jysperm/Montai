import { Composition, staticFile } from 'remotion';
import { CutFlowVideo, calculateTotalFrames, type EditSpecProps } from './CutFlowVideo';

export const RemotionRoot = () => {
  return (
    <Composition<EditSpecProps>
      id="CutFlow"
      component={CutFlowVideo}
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

        // Studio mode fallback: fetch spec from public dir when no props provided
        if (!spec.clips || spec.clips.length === 0) {
          const res = await fetch(staticFile('editSpec.json'));
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
