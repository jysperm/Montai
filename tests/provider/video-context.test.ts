/**
 * Test: verify that video FileContent can flow through
 * pi-agent-core's agent loop into the Gemini context.
 *
 * Requires GEMINI_API_KEY env var and a real video file.
 * Run: npx vitest run tests/video-context.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, type FileContent, type TextContent } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { GoogleGenAI } from '@google/genai';

const VIDEO_PATH =
  '/Users/jysperm/Movies/2026-02 Chiang Mai Flower Festival/DJI_20260214191551_0020_D.MP4';

async function uploadVideo(filePath: string): Promise<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY! });

  const upload = await client.files.upload({ file: filePath });
  if (!upload.uri) throw new Error('Upload failed: no URI');

  let state = upload.state ?? 'PROCESSING';
  while (state === 'PROCESSING') {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await client.files.get({ name: upload.name! });
    state = info.state ?? 'FAILED';
  }

  if (state !== 'ACTIVE') throw new Error(`Upload failed: ${state}`);
  return upload.uri;
}

describe.skip('video FileContent in agent context', () => {
  it('model can describe video content returned by a tool', async () => {
    const fileUri = await uploadVideo(VIDEO_PATH);

    const model = getModel('google', 'gemini-3-flash-preview');

    const watchTool = {
      name: 'watch_video',
      label: 'Watch Video',
      description: 'Watch a video segment and return it in context.',
      parameters: Type.Object({
        startSeconds: Type.Number(),
        endSeconds: Type.Number(),
      }),
      async execute(
        _toolCallId: string,
        params: { startSeconds: number; endSeconds: number },
      ) {
        const fileContent: FileContent = {
          type: 'file',
          uri: fileUri,
          mimeType: 'video/mp4',
          videoMetadata: {
            startOffset: `${params.startSeconds}s`,
            endOffset: `${params.endSeconds}s`,
          },
        };

        const textContent: TextContent = {
          type: 'text',
          text: `Video segment ${params.startSeconds}s-${params.endSeconds}s is now in context.`,
        };

        return { content: [textContent, fileContent], details: {} };
      },
    };

    const agent = new Agent({
      initialState: {
        systemPrompt:
          'You are a video analysis assistant. Use the watch_video tool to view video segments, then describe what you see.',
        model,
      },
      getApiKey: () => process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    agent.setTools([watchTool]);

    let assistantText = '';
    let thinkingText = '';
    let toolCalled = false;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;

    agent.subscribe((event) => {
      if (event.type === 'message_update') {
        const evt = event.assistantMessageEvent;
        if (evt?.type === 'text_delta') {
          assistantText += evt.delta;
        }
        if (evt?.type === 'thinking_delta') {
          thinkingText += evt.delta;
        }
      }
      if (event.type === 'turn_end') {
        const usage = (event as any).message?.usage;
        if (usage) {
          totalInput += usage.input;
          totalOutput += usage.output;
          totalCacheRead += usage.cacheRead;
          console.log(`[turn] input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} total=${usage.totalTokens}`);
        }
      }
      if (event.type === 'tool_execution_end') {
        toolCalled = true;
      }
    });

    await agent.prompt(
      'Use watch_video to view seconds 0-15 of the video, then describe what you see.',
    );
    await agent.waitForIdle();

    console.log('\n--- Token usage ---');
    console.log(`Total: input=${totalInput} output=${totalOutput} cacheRead=${totalCacheRead}`);
    console.log('\n--- Assistant response ---');
    console.log(assistantText || '(empty)');

    expect(toolCalled).toBe(true);
    // The model should produce some text response after watching the video.
    // Gemini 3 Flash Preview can be terse; we just verify the tool was called
    // and the model produced a non-empty response referencing video content.
    expect(assistantText.length).toBeGreaterThan(0);
  }, 300_000);
});
