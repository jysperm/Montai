import type { AssistantMessage, Message, TextContent } from '@mariozechner/pi-ai';
import type { complete } from '@mariozechner/pi-ai';
import type { ZodError, ZodType } from 'zod';
import { completeWithLogging } from '../utils/llm-logging.js';

export function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function assertComplete(result: AssistantMessage): void {
  if (result.stopReason === 'error') {
    throw new Error(result.errorMessage ?? 'LLM request failed');
  }
}

export function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

export interface SchemaRetryAttempt {
  attempt: number;
  result: AssistantMessage;
  error: string | null;
  isFinal: boolean;
}

export interface SchemaRetryResult<T> {
  data: T | null;
  raw: Record<string, unknown>;
  totalCost: number;
  lastResult: AssistantMessage;
  attempts: number;
  finalError: string | null;
}

export async function completeWithSchemaRetry<T>(opts: {
  model: Parameters<typeof complete>[0];
  messages: Message[];
  apiKey?: string;
  schema: ZodType<T>;
  maxRetries: number;
  onAttempt?: (info: SchemaRetryAttempt) => void;
}): Promise<SchemaRetryResult<T>> {
  const messages: Message[] = [...opts.messages];
  let totalCost = 0;
  let lastRaw: Record<string, unknown> = {};
  let lastResult!: AssistantMessage;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const result = await completeWithLogging(opts.model, { messages }, { apiKey: opts.apiKey });
    totalCost += result.usage.cost.total;
    lastResult = result;

    let parsed: Record<string, unknown> | null = null;
    let attemptError: string | null = null;

    if (result.stopReason === 'error') {
      attemptError = `LLM request failed: ${result.errorMessage ?? 'unknown error'}`;
    } else {
      const text = getTextContent(result);
      try {
        const raw = JSON.parse(extractJson(text)) as unknown;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          attemptError = `Response is not a JSON object (got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw})`;
          lastRaw = { overview: text };
        } else {
          parsed = raw as Record<string, unknown>;
          lastRaw = parsed;
        }
      } catch (e) {
        attemptError = `Response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
        lastRaw = { overview: text };
      }

      if (parsed) {
        const validation = opts.schema.safeParse(parsed);
        if (validation.success) {
          opts.onAttempt?.({ attempt, result, error: null, isFinal: true });
          return {
            data: validation.data,
            raw: parsed,
            totalCost,
            lastResult: result,
            attempts: attempt + 1,
            finalError: null,
          };
        }
        attemptError = `Schema mismatch: ${formatZodIssues(validation.error)}`;
      }
    }

    lastError = attemptError;
    const isFinal = attempt === opts.maxRetries;
    opts.onAttempt?.({ attempt, result, error: lastError, isFinal });

    if (!isFinal) {
      messages.push(result);
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Your previous response had problems: ${lastError}\n\nPlease retry. Respond with ONLY a valid JSON object matching the structure described in the original instructions, with no extra commentary or markdown fences.`,
          },
        ],
        timestamp: Date.now(),
      });
    }
  }

  return {
    data: null,
    raw: lastRaw,
    totalCost,
    lastResult,
    attempts: opts.maxRetries + 1,
    finalError: lastError,
  };
}

export class AsyncQueue<T> {
  private queue: T[] = [];
  private processing = false;
  private processor: (item: T) => Promise<void>;
  private resolveWhenDrained?: () => void;
  private itemCount = 0;
  private doneCount = 0;
  private sealed = false;

  constructor(processor: (item: T) => Promise<void>) {
    this.processor = processor;
  }

  enqueue(item: T): void {
    this.itemCount++;
    this.queue.push(item);
    void this.processNext();
  }

  seal(): void {
    this.sealed = true;
    this.checkDrained();
  }

  drain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveWhenDrained = resolve;
      this.checkDrained();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    try {
      await this.processor(item);
    } finally {
      this.doneCount++;
      this.processing = false;
      this.checkDrained();
      void this.processNext();
    }
  }

  private checkDrained(): void {
    if (
      this.sealed &&
      this.doneCount === this.itemCount &&
      this.queue.length === 0 &&
      !this.processing &&
      this.resolveWhenDrained
    ) {
      this.resolveWhenDrained();
    }
  }
}
