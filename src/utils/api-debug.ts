import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { streamSimple } from '@mariozechner/pi-ai';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';

const DEBUG_DIR = '.montai/logs';

// Summary of the outgoing request, so a dump makes it obvious e.g. that a turn
// was sent with no tools (which makes Gemini reject a tool-call attempt with
// finishReason MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL).
function summarizePayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { contents?: unknown; config?: Record<string, unknown> };
  const cfg = p.config ?? {};
  const toolBlocks = (cfg.tools as { functionDeclarations?: { name?: string }[] }[] | undefined) ?? [];
  const toolNames = toolBlocks.flatMap((b) => (b.functionDeclarations ?? []).map((d) => d.name ?? '?'));
  return {
    toolCount: toolNames.length,
    toolNames,
    contentCount: Array.isArray(p.contents) ? p.contents.length : undefined,
    thinkingConfig: cfg.thinkingConfig,
    maxOutputTokens: cfg.maxOutputTokens,
  };
}

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
      onPayload: (payload: unknown, model: any) => {
        this.lastPayload = payload;
        return options?.onPayload?.(payload, model);
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
          requestSummary: summarizePayload(this.lastPayload),
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
