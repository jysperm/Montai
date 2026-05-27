import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { availableParallelism, tmpdir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { outputDir } from './index.js';

const DURATION_SECONDS = 30;
const SAMPLE_RATE = 48000;
const VOICE_RATE = 250;
const SAY_CONCURRENCY = Math.max(1, availableParallelism() - 2);
const OUTPUT = resolve(outputDir, 'beep.wav');

function runAsync(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} failed with status ${code}`));
      }
    });
  });
}

async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

mkdirSync(outputDir, { recursive: true });

const workDir = mkdtempSync(resolve(tmpdir(), 'montai-test-audio-'));

try {
  const clips = Array.from({ length: DURATION_SECONDS }, (_, second) => resolve(workDir, `${second}.aiff`));

  await runLimited(
    Array.from({ length: DURATION_SECONDS }, (_, second) => second),
    SAY_CONCURRENCY,
    async second => runAsync('say', ['-r', String(VOICE_RATE), '-o', clips[second], String(second)]),
  );

  const args = [
    '-y',
    '-f', 'lavfi',
    '-t', String(DURATION_SECONDS),
    '-i', `anullsrc=r=${SAMPLE_RATE}:cl=stereo`,
  ];

  for (const clip of clips) {
    args.push('-i', clip);
  }

  const delayedLabels = clips.map((_, index) => {
    const delayMs = index * 1000;
    return `[${index + 1}:a]adelay=${delayMs}|${delayMs}[a${index}]`;
  });
  const mixInputs = ['[0:a]', ...clips.map((_, index) => `[a${index}]`)].join('');
  const filter = [
    ...delayedLabels,
    `${mixInputs}amix=inputs=${clips.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.8[out]`,
  ].join(';');

  args.push(
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    OUTPUT,
  );

  await runAsync('ffmpeg', args);

  if (!existsSync(OUTPUT)) {
    throw new Error(`Expected ${OUTPUT} to be created`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
