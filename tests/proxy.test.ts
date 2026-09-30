import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { expect, it, vi } from 'vitest';
import { loadGlobalEnv } from '../src/utils/global-env.js';
import { configureProxy } from '../src/utils/proxy.js';

it('uses the proxy from the env file for Gemini and child Node requests', async () => {
  const originalDispatcher = getGlobalDispatcher();
  const tunnels: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port');
  const tempDir = mkdtempSync(join(tmpdir(), 'montai-proxy-test-'));

  try {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
      vi.stubEnv(key, undefined);
    }
    const envFile = join(tempDir, 'env');
    writeFileSync(envFile, `HTTPS_PROXY=http://127.0.0.1:${address.port}\n`);
    loadGlobalEnv(envFile);
    configureProxy();

    const client = new GoogleGenAI({ apiKey: 'test-key' });
    await expect(client.models.generateContent({
      model: 'gemini-test',
      contents: 'hello',
    })).rejects.toThrow();

    const child = spawn(process.execPath, ['-e',
      'fetch("https://montai-proxy-test.invalid", { signal: AbortSignal.timeout(3000) }).catch(() => {})',
    ], { stdio: 'ignore' });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(exitCode).toBe(0);
    expect(tunnels).toContain('generativelanguage.googleapis.com:443');
    expect(tunnels).toContain('montai-proxy-test.invalid:443');
  } finally {
    setGlobalDispatcher(originalDispatcher);
    vi.unstubAllEnvs();
    proxy.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
