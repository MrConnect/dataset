import { describe, it, expect } from 'vitest';
import { formatTime, parseTimeString } from '../utils/time';

describe('Time Utilities', () => {
  it('formats seconds correctly', () => {
    expect(formatTime(0)).toBe('00:00.000');
    expect(formatTime(65.25)).toBe('01:05.250');
    expect(formatTime(3665.5, true)).toBe('01:01:05.500');
  });

  it('parses time string correctly', () => {
    expect(parseTimeString('01:05.250')).toBeCloseTo(65.25);
    expect(parseTimeString('01:01:05.500')).toBeCloseTo(3665.5);
    expect(parseTimeString('45.5')).toBeCloseTo(45.5);
  });
});
