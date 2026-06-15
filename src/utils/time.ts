export const TIMESTAMP_PATTERN = /^(?:\d+:[0-5]\d:[0-5]\d|\d+:[0-5]\d)(?:\.\d+)?$/;

export function timeToSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return Number(time);
}

export function parseTimestamp(time: string): number {
  if (!TIMESTAMP_PATTERN.test(time)) {
    throw new Error(`timestamp must use MM:SS or MM:SS.s format; got "${time}"`);
  }
  return timeToSeconds(time);
}

export function secondsToTimestamp(seconds: number): string {
  let mins = Math.floor(seconds / 60);
  let secs = Number((seconds - mins * 60).toFixed(3));
  if (secs >= 60) {
    mins += 1;
    secs = 0;
  }
  const secText = Number.isInteger(secs)
    ? String(secs).padStart(2, '0')
    : `${String(Math.floor(secs)).padStart(2, '0')}.${String(secs).split('.')[1]}`;
  return `${String(mins).padStart(2, '0')}:${secText}`;
}

export function secondsToRational(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  return `${frames}/${fps}s`;
}
