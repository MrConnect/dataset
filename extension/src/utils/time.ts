/**
 * Format seconds as HH:MM:SS.mmm or MM:SS.mmm
 */
export function formatTime(seconds: number, includeHours: boolean = false): string {
  if (isNaN(seconds) || seconds < 0) {
    seconds = 0;
  }

  // Work in whole milliseconds: floating point makes 2.3 % 1 = 0.2999…,
  // which would otherwise display as 00:02.299.
  const totalMs = Math.round(seconds * 1000);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

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

/**
 * Strict parser for times typed by the user.
 * Accepts "83.5", "1:23.5", "01:23.500" and "1:01:23.5". Returns null for
 * anything else instead of silently treating it as 0.
 */
export function parseTimeInput(str: string): number | null {
  const text = str.trim().replace(',', '.');
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return null;
  const parts = text.split(':');
  const hasHours = parts.length === 3;
  const seconds = parseFloat(parts.pop() as string);
  const minutes = parts.length ? parseInt(parts.pop() as string, 10) : 0;
  const hours = parts.length ? parseInt(parts.pop() as string, 10) : 0;
  // In "m:ss" the seconds must be below 60; in "h:mm:ss" the minutes too.
  if (text.includes(':') && seconds >= 60) return null;
  if (hasHours && minutes >= 60) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? Math.round(total * 1000) / 1000 : null;
}
