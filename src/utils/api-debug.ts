import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { streamSimple } from '@mariozechner/pi-ai';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';

const DEBUG_DIR = '.montai/logs';

export class ApiDebugCapture {
  private lastPayload: unknown = null;
  private lastContext: unknown = null;
  private lastModel: { id?: string; provider?: string; api?: string } | null = null;

  readonly streamFn: StreamFn = (model, context, options) => {
    this.lastPayload = null;
    this.lastContext = context;
    this.lastModel = { id: model.id, provider: model.provider, api: model.api };

    const wrappedOptions = {
      ...options,
      onPayload: (payload: unknown) => {
        this.lastPayload = payload;
        options?.onPayload?.(payload);
      },
    };

    return streamSimple(model, context, wrappedOptions);
  };

  dumpError(message: AssistantMessage): string | null {
    try {
      mkdirSync(DEBUG_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(DEBUG_DIR, `gemini-error-${ts}.json`);
      const body = JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          model: this.lastModel,
          errorMessage: message.errorMessage ?? null,
          stopReason: message.stopReason,
          requestPayload: this.lastPayload,
          context: this.lastContext,
          partialResponse: {
            content: message.content,
            usage: message.usage,
          },
        },
        null,
        2,
      );
      writeFileSync(path, body);
      return path;
    } catch {
      return null;
    }
  }
}
