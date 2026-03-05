import { useState, useEffect } from 'react';
import type { AnyZodObject } from 'zod';
import { Composition, staticFile } from 'remotion';
import { MontaiVideo, calculateTotalFrames, type TimelineProps } from './MontaiVideo';

export const RemotionRoot = () => {
  const [timelines, setTimelines] = useState<TimelineProps[]>([]);

  useEffect(() => {
    fetch(staticFile('timelines.json'))
      .then(r => r.json())
      .then(setTimelines)
      .catch(err => console.error('Failed to load timelines.json:', err));
  }, []);

  return (
    <>
      {timelines.map(spec => (
        <Composition<AnyZodObject, TimelineProps>
          key={spec.name}
          id={spec.name}
          component={MontaiVideo}
          durationInFrames={1}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={spec}
          calculateMetadata={async ({ props }) => {
            const data = props.clips?.length > 0 ? props : spec;
            return {
              props: data,
              durationInFrames: calculateTotalFrames(data),
              fps: data.fps,
              width: data.width,
              height: data.height,
            };
          }}
        />
      ))}
    </>
  );
};
