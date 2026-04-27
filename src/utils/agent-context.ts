import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { FileContent, TextContent, Message } from '@mariozechner/pi-ai';

const GEMINI_FILE_EXPIRY_MS = 48 * 60 * 60 * 1000;
const MAX_VIDEO_FILES_IN_CONTEXT = 10;

export function removeExpiredFileRefs(messages: AgentMessage[]): AgentMessage[] {
  const cutoff = Date.now() - GEMINI_FILE_EXPIRY_MS;

  return messages.map((msg) => {
    const m = msg as Message;
    if (m.role !== 'toolResult' || m.timestamp >= cutoff) return msg;
    if (!Array.isArray(m.content)) return msg;

    const hasFiles = (m.content as Array<{ type: string }>).some((c) => c.type === 'file');
    if (!hasFiles) return msg;

    const newContent = (m.content as Array<{ type: string }>).map((c) => {
      if (c.type === 'file') {
        return { type: 'text' as const, text: '(Video file reference expired after 48h. Refer to your earlier observations.)' } as TextContent;
      }
      return c;
    });

    return { ...m, content: newContent } as AgentMessage;
  });
}

/**
 * Extract FileContent from ToolResultMessages and place them in separate
 * UserMessages. This prevents fileData and functionResponse parts from
 * being mixed in the same Gemini API message (which causes 500 errors).
 *
 * For each consecutive group of toolResult messages, any FileContent items
 * are stripped out and re-injected as a synthetic Assistant+User message pair
 * inserted after the group.
 */
export function extractFileContentFromToolResults(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pendingFiles: FileContent[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Message;

    if (msg.role === 'toolResult') {
      const fileItems = (msg.content as Array<{ type: string }>).filter(
        (c): c is FileContent => c.type === 'file',
      );
      const nonFileItems = (msg.content as Array<{ type: string }>).filter(
        (c) => c.type !== 'file',
      );

      if (fileItems.length > 0) {
        // Push toolResult without FileContent
        result.push({
          ...msg,
          content: nonFileItems.length > 0
            ? nonFileItems
            : [{ type: 'text' as const, text: 'Video segment loaded into context.' }],
        } as AgentMessage);
        pendingFiles.push(...fileItems);
      } else {
        result.push(messages[i]);
      }

      // Check if this is the last toolResult in a consecutive group
      const nextMsg = i + 1 < messages.length ? (messages[i + 1] as Message) : null;
      if (pendingFiles.length > 0 && (!nextMsg || nextMsg.role !== 'toolResult')) {
        // Insert synthetic assistant + user pair carrying the FileContent
        result.push({
          role: 'assistant',
          content: [{ type: 'text' as const, text: 'I have received the video segments.' }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now(),
        } as AgentMessage);
        result.push({
          role: 'user',
          content: [
            { type: 'text' as const, text: 'Video segments for review:' } as TextContent,
            ...pendingFiles,
          ],
          timestamp: Date.now(),
        } as AgentMessage);
        pendingFiles = [];
      }
    } else {
      result.push(messages[i]);
    }
  }

  return result;
}

/**
 * Scan messages for FileContent items (type === 'file') and replace
 * the oldest ones beyond the limit with a text placeholder.
 */
export function limitVideoFilesInContext(messages: AgentMessage[]): AgentMessage[] {
  // Collect all (messageIndex, contentIndex) pairs for FileContent items
  const fileLocations: { msgIdx: number; contentIdx: number }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if ('content' in msg && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        if ((msg.content[j] as { type: string }).type === 'file') {
          fileLocations.push({ msgIdx: i, contentIdx: j });
        }
      }
    }
  }

  if (fileLocations.length <= MAX_VIDEO_FILES_IN_CONTEXT) {
    return messages;
  }

  // Clone messages we need to modify, keep the newest MAX files
  const toEvict = fileLocations.slice(0, fileLocations.length - MAX_VIDEO_FILES_IN_CONTEXT);
  const evictSet = new Set(toEvict.map((l) => `${l.msgIdx}:${l.contentIdx}`));
  const result = messages.map((msg, msgIdx) => {
    if (!('content' in msg) || !Array.isArray(msg.content)) return msg;

    let hasEviction = false;
    for (const loc of toEvict) {
      if (loc.msgIdx === msgIdx) { hasEviction = true; break; }
    }
    if (!hasEviction) return msg;

    const newContent = msg.content.map((item: { type: string }, contentIdx: number) => {
      if (evictSet.has(`${msgIdx}:${contentIdx}`)) {
        return { type: 'text' as const, text: '(Video segment previously watched, no longer in context. Refer to your earlier observations.)' } as TextContent;
      }
      return item;
    });
    return { ...msg, content: newContent };
  });

  return result as AgentMessage[];
}
