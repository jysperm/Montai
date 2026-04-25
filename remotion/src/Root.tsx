import { useState, useEffect } from 'react';
import type { AnyZodObject } from 'zod';
import { Composition, staticFile, watchStaticFile } from 'remotion';
import { MontaiVideo, calculateTotalFrames, type TimelineProps } from './MontaiVideo';

function loadTimelinesSync(): TimelineProps[] {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', staticFile('timelines.json'), false);
    xhr.send();
    if (xhr.status === 200) {
      return JSON.parse(xhr.responseText);
    }
  } catch (err) {
    console.error('Failed to load timelines.json:', err);
  }
  return [];
}

export const RemotionRoot = () => {
  const [timelines, setTimelines] = useState(() => loadTimelinesSync());

  useEffect(() => {
    const { cancel } = watchStaticFile('timelines.json', () => {
      fetch(staticFile('timelines.json'))
        .then(r => r.json())
        .then(data => setTimelines(data))
        .catch(err => console.error('Failed to reload timelines.json:', err));
    });
    return cancel;
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
