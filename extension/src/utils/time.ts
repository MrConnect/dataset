/**
 * Format seconds as HH:MM:SS.mmm or MM:SS.mmm
 */
export function formatTime(seconds: number, includeHours: boolean = false): string {
  if (isNaN(seconds) || seconds < 0) {
    seconds = 0;
  }

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');

  if (includeHours || hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
  }
  return `${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
}

/**
 * Parses time string (e.g. "01:23.450" or "01:10:23.5") to total seconds
 */
export function parseTimeString(str: string): number {
  const parts = str.trim().split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return (parseFloat(h) || 0) * 3600 + (parseFloat(m) || 0) * 60 + (parseFloat(s) || 0);
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return (parseFloat(m) || 0) * 60 + (parseFloat(s) || 0);
  }
  return parseFloat(str) || 0;
}
