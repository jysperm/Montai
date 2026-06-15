import { defaultsMap, type TimelineItem } from '../timeline.js';

/**
 * Strip fields that match their Zod-schema default values from timeline items.
 * Used when serializing for DB storage and LLM context to reduce noise.
 */
export function stripTimelineDefaults(items: TimelineItem[]): Record<string, unknown>[] {
  return items.map((item) => {
    const defaults = defaultsMap[item.type] ?? {};
    const obj: Record<string, unknown> = { ...item };
    for (const [key, defaultVal] of Object.entries(defaults)) {
      if (obj[key] === defaultVal) delete obj[key];
    }
    return obj;
  });
}

/**
 * Splice timeline items with automatic clipIndex remapping for overlay/music/voiceover items.
 * Similar to Array.prototype.splice: remove `deleteCount` items starting at `index`,
 * then insert `newItems` at that position. Use deleteCount=-1 to delete all from index.
 */
export function spliceTimelineItems(
  currentItems: TimelineItem[],
  index: number,
  deleteCount: number,
  newItems: TimelineItem[] = [],
): TimelineItem[] {
  const items = [...currentItems];

  // Handle deleteCount=-1 as "delete all from index"
  const effectiveDeleteCount = deleteCount === -1 ? items.length - index : deleteCount;

  // Count clip items in the deleted range
  const deletedSlice = items.slice(index, index + effectiveDeleteCount);
  const deletedClipCount = deletedSlice.filter((i) => i.type === 'clip').length;

  // Count clip items in the new items
  const insertedClipCount = newItems.filter((i) => i.type === 'clip').length;

  // Find the clip index of the first clip at or after `index`
  let clipIndexAtSplicePoint = 0;
  for (let i = 0; i < index && i < items.length; i++) {
    if (items[i].type === 'clip') {
      clipIndexAtSplicePoint++;
    }
  }

  // Perform the splice
  items.splice(index, effectiveDeleteCount, ...newItems);

  // Remap clipIndex references in overlay/music/voiceover items that are outside the spliced range
  const clipDelta = insertedClipCount - deletedClipCount;
  if (clipDelta !== 0) {
    for (const item of items) {
      if (item.type === 'overlay' || item.type === 'music' || item.type === 'voiceover') {
        if (item.startClip >= clipIndexAtSplicePoint + deletedClipCount) {
          item.startClip += clipDelta;
        }
        if ('endClip' in item && item.endClip !== undefined && item.endClip >= clipIndexAtSplicePoint + deletedClipCount) {
          item.endClip += clipDelta;
        }
      }
    }
  }

  return items;
}
