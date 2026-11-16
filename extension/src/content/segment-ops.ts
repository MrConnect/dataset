import { Segment } from '../types';

/** Times are kept to the millisecond so values typed or displayed round-trip exactly. */
export function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** Video order: by start, then by end, then by id for a stable result. */
export function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort(
    (a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds || a.id.localeCompare(b.id)
  );
}

/** Ids of segments that overlap the segment before them (input must be sorted). */
export function findOverlaps(sorted: Segment[]): Set<string> {
  const overlapping = new Set<string>();
  let furthestEnd = -Infinity;
  let furthestId: string | null = null;
  for (const segment of sorted) {
    if (segment.start_seconds < furthestEnd - 0.0005) {
      overlapping.add(segment.id);
      if (furthestId) overlapping.add(furthestId);
    }
    if (segment.end_seconds > furthestEnd) {
      furthestEnd = segment.end_seconds;
      furthestId = segment.id;
    }
  }
  return overlapping;
}

/** The segment the playhead is inside, preferring the one that started last. */
export function segmentAt(sorted: Segment[], time: number): Segment | null {
  let match: Segment | null = null;
  for (const segment of sorted) {
    if (segment.start_seconds > time) break;
    if (time < segment.end_seconds) match = segment;
  }
  return match;
}

/** Returns a reason the range cannot be used, or null when it is valid. */
export function rangeError(start: number, end: number, duration?: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter a valid time';
  if (start < 0) return 'Start cannot be before 0';
  if (end <= start) return 'End must be after start';
  if (end - start < 0.1) return 'A segment must be at least 0.1 s long';
  if (duration && Number.isFinite(duration) && duration > 0 && end > duration + 0.05) {
    return 'End is past the end of the video';
  }
  return null;
}

/** Clamp a time into the video. */
export function clampTime(seconds: number, duration?: number): number {
  const upper = duration && Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return roundTime(Math.min(Math.max(0, seconds), upper));
}
