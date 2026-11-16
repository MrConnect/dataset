/**
 * Inline SVG icons for the on-player overlay.
 *
 * The overlay is injected into arbitrary pages, so it cannot rely on an icon
 * font or a sprite in the host document; every icon is a self-contained
 * string that inherits the button's text colour.
 */

function stroke(body: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;display:block">${body}</svg>`;
}

function solid(body: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex:none;display:block">${body}</svg>`;
}

export const ICONS = {
  play: solid('<polygon points="6 3 20 12 6 21 6 3"></polygon>'),
  pause: solid('<rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect>'),
  /** Segment start: an opening bracket. */
  markIn: stroke('<path d="M10 4H6v16h4"/><path d="M13 12h6"/>'),
  /** Segment end: a closing bracket. */
  markOut: stroke('<path d="M14 4h4v16h-4"/><path d="M5 12h6"/>'),
  check: stroke('<path d="m5 12 5 5 9-10"/>'),
  close: stroke('<path d="M6 6l12 12M18 6 6 18"/>'),
  tag: stroke('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>', 13),
  plus: stroke('<path d="M12 5v14M5 12h14"/>', 13),
  layers: stroke('<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>'),
  send: stroke('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
  loader: stroke('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.9 2.9M15.5 15.5l2.9 2.9M5.6 18.4l2.9-2.9M15.5 8.5l2.9-2.9"/>'),
  minimize: stroke('<path d="m6 9 6 6 6-6"/>'),
  expand: stroke('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>', 22),
  chevronDown: stroke('<polyline points="6 9 12 15 18 9"></polyline>', 10),
  pencil: stroke('<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>', 13),
  /** Jump to the start of a segment. */
  seek: stroke('<path d="M5 4v16"/><path d="m9 5 10 7-10 7z"/>', 13),
  trash: stroke('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>', 13),
  saved: stroke('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>', 11),
  undo: stroke('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>'),
  alert: stroke('<path d="M12 4 2.5 20h19zM12 10v4M12 17v.5"/>', 13),
  minus: stroke('<path d="M5 12h14"/>', 13),
  crosshair: stroke('<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>', 13),
  frameBack: stroke('<path d="m15 6-6 6 6 6"/>'),
  frameForward: stroke('<path d="m9 6 6 6-6 6"/>'),
  editing: stroke('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 12),
  restore: stroke('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', 16),
};

/** Category and label names come from user data and are rendered via innerHTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
