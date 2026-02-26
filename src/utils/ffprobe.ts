import { execFileSync } from 'child_process';

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fpsNum: number;   // frame rate numerator, e.g. 60000
  fpsDen: number;   // frame rate denominator, e.g. 1001
  totalFrames: number | null;
  bitDepth: number | null;
  colorSpace: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  startTimecode: string | null;    // e.g. "15:03:38;24"
}

export function getVideoMetadata(filepath: string): VideoMetadata {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filepath,
  ], { encoding: 'utf-8' });

  const data = JSON.parse(output);
  const videoStream = data.streams?.find(
    (s: { codec_type: string }) => s.codec_type === 'video'
  );

  const durationSeconds = parseFloat(data.format?.duration ?? '0');
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;

  let fpsNum = 30;
  let fpsDen = 1;
  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0) {
      fpsNum = num;
      fpsDen = den;
    }
  }

  let bitDepth: number | null = null;
  if (videoStream?.bits_per_raw_sample) {
    bitDepth = parseInt(videoStream.bits_per_raw_sample, 10);
  } else if (videoStream?.pix_fmt) {
    const match = videoStream.pix_fmt.match(/(\d+)le$/);
    if (match) bitDepth = parseInt(match[1], 10);
  }

  const totalFrames: number | null = videoStream?.nb_frames ? parseInt(videoStream.nb_frames, 10) : null;
  const colorSpace: string | null = videoStream?.color_space ?? null;
  const colorPrimaries: string | null = videoStream?.color_primaries ?? null;
  const colorTransfer: string | null = videoStream?.color_transfer ?? null;

  const audioStream = data.streams?.find(
    (s: { codec_type: string }) => s.codec_type === 'audio'
  );
  const audioChannels: number | null = audioStream?.channels ?? null;
  const audioSampleRate: number | null = audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : null;

  const startTimecode: string | null = data.format?.tags?.timecode ?? videoStream?.tags?.timecode ?? null;

  return { durationSeconds: Math.round(durationSeconds), width, height, fpsNum, fpsDen, totalFrames, bitDepth, colorSpace, colorPrimaries, colorTransfer, audioChannels, audioSampleRate, startTimecode };
}

export function getVideoDuration(filepath: string): number {
  return getVideoMetadata(filepath).durationSeconds;
}
