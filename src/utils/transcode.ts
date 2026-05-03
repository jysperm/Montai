import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

const TRANSCODE_DIR = '.montai/transcoded';

// Filename encodes the sample fps so that different fps requests don't clobber
// each other. fps=1 keeps the legacy unsuffixed name for cache continuity.
function getTranscodedPath(videoId: number, fps: number): string {
  const suffix = fps === 1 ? '' : `-${fps}fps`;
  return join(TRANSCODE_DIR, `${videoId}${suffix}.mp4`);
}

function isTranscodedFresh(transcodedPath: string, sourcePath: string): boolean {
  if (!existsSync(transcodedPath)) return false;
  const srcMtime = statSync(sourcePath).mtimeMs;
  const outMtime = statSync(transcodedPath).mtimeMs;
  return outMtime > srcMtime;
}

// A transcode at fps=N can serve any request for fps<=N (Gemini just ignores
// extra frames). Pick the smallest fresh cache that satisfies the request to
// keep the upload size minimal.
function findReusableTranscode(videoId: number, requiredFps: number, sourcePath: string): string | null {
  if (!existsSync(TRANSCODE_DIR)) return null;
  const pattern = new RegExp(`^${videoId}(?:-(\\d+(?:\\.\\d+)?)fps)?\\.mp4$`);
  const candidates = readdirSync(TRANSCODE_DIR)
    .map((name) => {
      const m = name.match(pattern);
      if (!m) return null;
      const fps = m[1] ? parseFloat(m[1]) : 1;
      return { name, fps };
    })
    .filter((c): c is { name: string; fps: number } => c !== null && c.fps >= requiredFps)
    .sort((a, b) => a.fps - b.fps);
  for (const c of candidates) {
    const p = join(TRANSCODE_DIR, c.name);
    if (isTranscodedFresh(p, sourcePath)) return p;
  }
  return null;
}

/**
 * Transcode video to a low-fps, 720p, 8-bit mp4 for Gemini upload.
 * Result cached at .montai/transcoded/{videoId}[-Nfps].mp4. A request at fps=N
 * may reuse an existing transcode at any fps>=N (the returned `path` may be a
 * higher-fps reuse — its basename uniquely identifies the file).
 */
export interface TranscodeResult {
  path: string;
  cached: boolean;
}

export async function transcodeForUpload(videoId: number, sourcePath: string, fps = 1): Promise<TranscodeResult> {
  const reusable = findReusableTranscode(videoId, fps, sourcePath);
  if (reusable) return { path: reusable, cached: true };

  const outPath = getTranscodedPath(videoId, fps);
  mkdirSync(dirname(outPath), { recursive: true });

  const tmpPath = outPath.replace(/\.mp4$/, '.tmp.mp4');

  return new Promise<TranscodeResult>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-i', sourcePath,
      '-vf', `scale=-2:720,fps=${fps}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ac', '1',
      tmpPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrTail = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrTail = data.toString().slice(-2000);
    });

    const cleanup = () => {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {}
    };

    const onSignal = () => {
      child.kill();
      cleanup();
      process.exit(1);
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    child.on('close', (code) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);

      if (code === 0) {
        renameSync(tmpPath, outPath);
        resolve({ path: outPath, cached: false });
      } else {
        cleanup();
        const detail = stderrTail.trim();
        reject(new Error(`ffmpeg exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });

    child.on('error', (err) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      cleanup();
      reject(err);
    });
  });
}
