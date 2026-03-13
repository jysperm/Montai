import type { AssistantMessage, TextContent } from '@mariozechner/pi-ai';

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
