import { spawn } from 'child_process';
import { existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

const TRANSCODE_DIR = '.cutflow/transcoded';

function getTranscodedPath(videoId: number): string {
  return join(TRANSCODE_DIR, `${videoId}.mp4`);
}

function isTranscodedFresh(transcodedPath: string, sourcePath: string): boolean {
  if (!existsSync(transcodedPath)) return false;
  const srcMtime = statSync(sourcePath).mtimeMs;
  const outMtime = statSync(transcodedPath).mtimeMs;
  return outMtime > srcMtime;
}

/**
 * Transcode video to 1 FPS, 720p, 8-bit color for Gemini upload.
 * Caches the result in .cutflow/transcoded/{videoId}.mp4.
 *
 * Uses async spawn so that SIGINT/SIGTSTP are handled properly
 * (the event loop stays free to process signals).
 * Writes to a temp file and renames on success to avoid leaving
 * partial files that would be mistaken for valid cache.
 */
export interface TranscodeResult {
  path: string;
  cached: boolean;
}

export async function transcodeForUpload(videoId: number, sourcePath: string): Promise<TranscodeResult> {
  const outPath = getTranscodedPath(videoId);

  if (isTranscodedFresh(outPath, sourcePath)) {
    return { path: outPath, cached: true };
  }

  mkdirSync(dirname(outPath), { recursive: true });

  const tmpPath = outPath.replace(/\.mp4$/, '.tmp.mp4');

  return new Promise<TranscodeResult>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-i', sourcePath,
      '-vf', 'scale=-2:720,fps=1',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ac', '1',
      tmpPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Drain stderr to prevent pipe buffer from filling up;
    // keep the tail for error reporting.
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
