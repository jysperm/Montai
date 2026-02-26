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

export function secondsToTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function secondsToRational(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  return `${frames}/${fps}s`;
}
