import createDebug from 'debug';
import { complete as piComplete } from '@mariozechner/pi-ai';
import type { AssistantMessage, Message, UserMessage, TextContent, ImageContent, FileContent } from '@mariozechner/pi-ai';

const debugAgent = createDebug('montai:agent');
const debugReq = createDebug('montai:req');
const debugReqVerbose = createDebug('montai:req:verbose');
const debugRes = createDebug('montai:res');
const debugResVerbose = createDebug('montai:res:verbose');
const debugTool = createDebug('montai:tool');
const debugToolVerbose = createDebug('montai:tool:verbose');

function splitLines(text: string): { firstLine: string; remainingLines: string; moreCount: number } {
  const trimmed = text.trim();
  if (!trimmed) return { firstLine: '', remainingLines: '', moreCount: 0 };
  const lines = trimmed.split('\n');
  return {
    firstLine: lines[0],
    remainingLines: lines.slice(1).join('\n'),
    moreCount: lines.length - 1,
  };
}

function formatWithMore(firstLine: string, moreCount: number): string {
  if (moreCount <= 0) return firstLine;
  return `${firstLine} ... (${moreCount} more lines)`;
}

function formatUserContent(content: string | (TextContent | ImageContent | FileContent)[]): string {
  if (typeof content === 'string') return content;
  return content.map(c => {
    switch (c.type) {
      case 'text': return c.text;
      case 'image': return `[Image: ${c.mimeType}]`;
      case 'file': return `[File: ${c.uri}]`;
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

function extractToolResultText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string; uri?: string; mimeType?: string }> };
  if (!r?.content) return '';
  return r.content
    .map(c => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'file') return `[File: ${c.uri}]`;
      if (c.type === 'image') return `[Image: ${c.mimeType}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Log request messages. Prints user messages after the last assistant message.
 * If no assistant messages exist (new conversation), also prints the system prompt.
 */
export function logRequest(messages: Message[], systemPrompt?: string): void {
  if (!debugReq.enabled) return;

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1 && systemPrompt) {
    const { firstLine, remainingLines, moreCount } = splitLines(systemPrompt);
    debugReq('[System] %s', formatWithMore(firstLine, moreCount));
    if (moreCount > 0 && debugReqVerbose.enabled) {
      debugReqVerbose('[System] %s', remainingLines.trim());
    }
  }

  const userMessages: UserMessage[] = [];
  for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      userMessages.push(messages[i] as UserMessage);
    }
  }

  if (userMessages.length === 0) return;

  const combinedText = userMessages.map(m => formatUserContent(m.content)).join('\n');
  const { firstLine, remainingLines, moreCount } = splitLines(combinedText);
  debugReq('%s', formatWithMore(firstLine, moreCount));
  if (moreCount > 0 && debugReqVerbose.enabled) {
    debugReqVerbose('%s', remainingLines.trim());
  }
}

/**
 * Log the agent step line after an LLM call completes.
 */
export function logStep(options: {
  step?: number;
  maxSteps?: number;
  model: string;
  usage: { input: number; output: number; cacheRead: number };
  durationMs: number;
}): void {
  if (!debugAgent.enabled) return;

  const { step, maxSteps, model, usage, durationMs } = options;
  const seconds = Math.round(durationMs / 1000);
  const totalInput = usage.input + usage.cacheRead;
  const cacheRate = totalInput > 0 ? Math.round((usage.cacheRead / totalInput) * 100) : 0;

  let stepPart = '';
  if (step != null) {
    stepPart = maxSteps != null ? `Step ${step}/${maxSteps} ` : `Step ${step} `;
  }

  debugAgent('%s[%s] ↑%d ↓%d %ds (%d%% cached)', stepPart, model, totalInput, usage.output, seconds, cacheRate);
}

/**
 * Log the LLM response text.
 */
export function logResponse(message: AssistantMessage): void {
  if (!debugRes.enabled) return;

  const textParts = message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text);

  if (textParts.length === 0) return;

  const combinedText = textParts.join('');
  const { firstLine, remainingLines, moreCount } = splitLines(combinedText);
  debugRes('[%s] %s', message.model, formatWithMore(firstLine, moreCount));
  if (moreCount > 0 && debugResVerbose.enabled) {
    debugResVerbose('%s', remainingLines.trim());
  }
}

/**
 * Log a tool call with its arguments and result.
 */
export function logToolCall(toolName: string, args: Record<string, unknown>, result: unknown): void {
  if (!debugTool.enabled) return;

  const argsStr = JSON.stringify(args);
  const resultText = extractToolResultText(result);
  const { firstLine, remainingLines, moreCount } = splitLines(resultText || '(empty)');
  debugTool('Called %s: %s: %s', toolName, argsStr, formatWithMore(firstLine, moreCount));
  if (moreCount > 0 && debugToolVerbose.enabled) {
    debugToolVerbose('%s', remainingLines.trim());
  }
}

/**
 * Wrapper around `complete()` that adds logging.
 */
export async function completeWithLogging(
  ...args: Parameters<typeof piComplete>
): ReturnType<typeof piComplete> {
  const [, context] = args;
  logRequest(context.messages, context.systemPrompt);
  const t0 = Date.now();
  const result = await piComplete(...args);
  logStep({ model: result.model, usage: result.usage, durationMs: Date.now() - t0 });
  logResponse(result);
  return result;
}
