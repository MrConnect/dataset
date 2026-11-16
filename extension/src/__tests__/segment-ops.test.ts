import { describe, it, expect } from 'vitest';
import { clampTime, findOverlaps, rangeError, segmentAt, sortSegments } from '../content/segment-ops';
import { formatTime, parseTimeInput } from '../utils/time';

const seg = (id: string, start: number, end: number) => ({ id, start_seconds: start, end_seconds: end, categories: ['x'] });

describe('segment ordering and checks', () => {
  it('sorts segments in video order regardless of creation order', () => {
    const sorted = sortSegments([seg('c', 30, 40), seg('a', 5, 9), seg('b', 5, 7)]);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('flags overlapping segments only', () => {
    const sorted = sortSegments([seg('a', 0, 10), seg('b', 8, 12), seg('c', 12, 15), seg('d', 20, 21)]);
    expect([...findOverlaps(sorted)].sort()).toEqual(['a', 'b']);
  });

  it('finds the segment under the playhead', () => {
    const sorted = sortSegments([seg('a', 0, 10), seg('b', 20, 30)]);
    expect(segmentAt(sorted, 5)?.id).toBe('a');
    expect(segmentAt(sorted, 15)).toBeNull();
    expect(segmentAt(sorted, 30)).toBeNull();
  });

  it('validates ranges', () => {
    expect(rangeError(5, 4)).toMatch(/after start/);
    expect(rangeError(-1, 4)).toMatch(/before 0/);
    expect(rangeError(1, 1.05)).toMatch(/0.1/);
    expect(rangeError(1, 61, 60)).toMatch(/past the end/);
    expect(rangeError(1, 60.02, 60)).toBeNull();
    expect(clampTime(70, 60)).toBe(60);
    expect(clampTime(-2, 60)).toBe(0);
  });
});

describe('time input', () => {
  it('parses typed times strictly', () => {
    expect(parseTimeInput('83.5')).toBe(83.5);
    expect(parseTimeInput('1:23.5')).toBe(83.5);
    expect(parseTimeInput('01:01:05.500')).toBe(3665.5);
    expect(parseTimeInput('2,25')).toBe(2.25);
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('1:75')).toBeNull();
    expect(parseTimeInput('')).toBeNull();
  });

  it('formats without floating point drift', () => {
    expect(formatTime(2.3)).toBe('00:02.300');
    expect(formatTime(59.9999)).toBe('01:00.000');
  });
});
