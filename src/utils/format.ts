/**
 * Format seconds into a human-readable duration string.
 * Examples: "15s", "3m12s", "3m", "1h30m", "1h30m15s"
 */
export function formatDuration(seconds: number): string {
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return s > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Format an ISO timestamp as relative time (e.g., "3 hours ago", "just now").
 */
export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days !== 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Format bytes into a human-readable size string (1024-based).
 * Examples: "512 B", "1.5 KB", "23.4 MB", "1.2 GB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function countItemsByType(items: Array<{ type: string }>): { clips: number; overlays: number; audio: number } {
  return {
    clips: items.filter(i => i.type === 'clip').length,
    overlays: items.filter(i => i.type === 'overlay').length,
    audio: items.filter(i => i.type === 'audio').length,
  };
}

export function formatItemCounts(counts: { clips: number; overlays: number; audio: number }): string {
  const parts: string[] = [];
  if (counts.clips > 0) parts.push(`${counts.clips} clip${counts.clips !== 1 ? 's' : ''}`);
  if (counts.overlays > 0) parts.push(`${counts.overlays} overlay${counts.overlays !== 1 ? 's' : ''}`);
  if (counts.audio > 0) parts.push(`${counts.audio} audio`);
  return parts.join(', ') || 'nothing';
}
