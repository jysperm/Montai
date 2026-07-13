import { GoogleAuth } from 'google-auth-library';
import createDebug from 'debug';

const LYRIA_MODEL = 'lyria-002';

const debugAgent = createDebug('montai:agent');
const debugReq = createDebug('montai:req');
const debugReqVerbose = createDebug('montai:req:verbose');
const debugRes = createDebug('montai:res');

interface LyriaPrediction {
  bytesBase64Encoded?: string;
  audioContent?: string;
  mimeType?: string;
}

/**
 * Call the Lyria 2 music generation API on Vertex AI.
 * Returns a WAV buffer (~30s of instrumental music at 48kHz stereo).
 *
 * Requires:
 * - GOOGLE_CLOUD_PROJECT env var
 * - GOOGLE_CLOUD_REGION env var (defaults to us-central1)
 * - Application Default Credentials (gcloud auth application-default login)
 */
export async function callLyria(prompt: string): Promise<Buffer> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_REGION ?? 'us-central1';

  if (!project) {
    throw new Error(
      'GOOGLE_CLOUD_PROJECT environment variable is required for music generation.\n' +
      'Set up Google Cloud credentials:\n' +
      '  1. gcloud auth application-default login\n' +
      '  2. export GOOGLE_CLOUD_PROJECT=your-project-id',
    );
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  let accessToken: string | null | undefined;
  try {
    const client = await auth.getClient();
    accessToken = (await client.getAccessToken()).token;
  } catch (err) {
    throw new Error(
      `Failed to get Google Cloud credentials. Run: gcloud auth application-default login\n` +
      `Original error: ${err instanceof Error ? err.message : err}`,
    );
  }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${LYRIA_MODEL}:predict`;

  const body = {
    instances: [{ prompt }],
    parameters: {},
  };

  const trimmed = prompt.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0];
  const moreCount = lines.length - 1;
  debugReq('[%s] %s', LYRIA_MODEL, moreCount > 0 ? `${firstLine} ... (${moreCount} more lines)` : firstLine);
  if (moreCount > 0 && debugReqVerbose.enabled) {
    debugReqVerbose('[%s] %s', LYRIA_MODEL, lines.slice(1).join('\n').trim());
  }
  const t0 = Date.now();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Lyria API error (${response.status}): ${text}`);
  }

  const data = await response.json() as { predictions?: LyriaPrediction[] };
  const prediction = data.predictions?.[0];
  const base64Audio = prediction?.bytesBase64Encoded ?? prediction?.audioContent;

  if (!base64Audio) {
    throw new Error('Lyria API returned no audio content');
  }

  const buf = Buffer.from(base64Audio, 'base64');
  const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
  debugAgent('[%s] %ds', LYRIA_MODEL, Math.round((Date.now() - t0) / 1000));
  debugRes('[%s] %sMB audio', LYRIA_MODEL, sizeMB);

  return buf;
}
