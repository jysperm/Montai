export function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function toRational(seconds: number, fps: number): string {
  return `${Math.round(seconds * fps)}/${fps}s`;
}

export function framesToRational(frames: number, fpsNum: number, fpsDen: number): string {
  return `${frames * fpsDen}/${fpsNum}s`;
}

export function fcpName(str: string): string {
  return escapeXml(str.replace(/\//g, '-').replace(/[\r\n]+/g, ' '));
}

export function round4(n: number): string {
  return Number(n.toFixed(4)).toString();
}
