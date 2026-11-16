import { Category, Segment } from '../types';
import { formatTime, parseTimeInput } from '../utils/time';
import { ICONS, escapeHtml } from './icons';

export type SegmentEdge = 'start' | 'end';

export interface DrawerCallbacks {
  onSelect: (id: string | null) => void;
  onSeek: (time: number) => void;
  onPlaySegment: (id: string) => void;
  /** Returns an error message when the time was rejected. */
  onSetTime: (id: string, edge: SegmentEdge, seconds: number) => string | null;
  onSetToPlayhead: (id: string, edge: SegmentEdge) => void;
  onNudge: (id: string, edge: SegmentEdge, delta: number) => void;
  onChangeCategory: (id: string, categoryId: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onUndo: () => void;
  onSubmit: () => Promise<void>;
}

export interface DrawerState {
  segments: Segment[];
  categories: Category[];
  selectedId: string | null;
  overlaps: Set<string>;
  undoLabel: string | null;
}

const NUDGE = 0.1;
const NUDGE_LARGE = 1;
const NUDGE_FINE = 0.01;

/**
 * Segment list shown above the player bar.
 *
 * Rows are always in video order. Selecting a row opens its editor: exact
 * start/end fields (type a time, use ↑/↓ to nudge), buttons to take the
 * current playhead, and fine nudges. Every change goes through the
 * controller, which validates it and keeps an undo history.
 */
export class PlayerDrawer {
  private container: HTMLDivElement;
  private playerParent: HTMLElement;

  private state: DrawerState = { segments: [], categories: [], selectedId: null, overlaps: new Set(), undoLabel: null };
  private activeId: string | null = null;
  private isVisible = false;
  private isSubmitting = false;
  private statusMessage: { text: string; kind: 'info' | 'error' } | null = null;
  private clearArmedUntil = 0;
  private callbacks?: DrawerCallbacks;
  private rendering = false;

  constructor(_videoEl: HTMLVideoElement, playerParent: HTMLElement) {
    this.playerParent = playerParent;
    this.container = document.createElement('div');
    this.container.className = 'vdt-segments-drawer';
    this.container.style.display = 'none';

    // Keep clicks and keys inside the panel from reaching the site's player
    // (pausing, seeking or toggling fullscreen on its own shortcuts).
    for (const type of ['click', 'dblclick', 'mousedown', 'pointerdown', 'keydown', 'keyup', 'keypress', 'wheel']) {
      this.container.addEventListener(type, (e) => e.stopPropagation());
    }
    this.container.addEventListener('click', (e) => this.handleClick(e));
    this.container.addEventListener('change', (e) => this.handleChange(e));
    this.container.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.container.addEventListener('focusout', (e) => this.handleFocusOut(e));

    this.playerParent.appendChild(this.container);

    document.addEventListener('fullscreenchange', () => this.handleFullscreen());
    document.addEventListener('webkitfullscreenchange', () => this.handleFullscreen());
  }

  public reparent(newParent: HTMLElement): void {
    this.playerParent = newParent;
    if (this.container.parentElement !== newParent) {
      newParent.appendChild(this.container);
    }
  }

  private handleFullscreen(): void {
    const fsEl = document.fullscreenElement as HTMLElement;
    if (fsEl && !fsEl.contains(this.container)) {
      fsEl.appendChild(this.container);
    } else if (!fsEl && !this.playerParent.contains(this.container)) {
      this.playerParent.appendChild(this.container);
    }
  }

  /** Keep the panel just above the control bar, whatever the bar's height. */
  public setBottomOffset(pixels: number): void {
    this.container.style.setProperty('bottom', `${Math.round(pixels)}px`, 'important');
    this.container.style.setProperty('max-height', `calc(100% - ${Math.round(pixels) + 16}px)`, 'important');
  }

  public setCallbacks(callbacks: DrawerCallbacks): void {
    this.callbacks = callbacks;
  }

  public updateData(state: DrawerState): void {
    const selectionChanged = state.selectedId !== this.state.selectedId;
    this.state = state;
    if (this.isVisible) {
      this.render();
      if (selectionChanged && state.selectedId) this.scrollToRow(state.selectedId);
    }
  }

  /** Highlight the segment under the playhead without re-rendering. */
  public setPlayhead(activeId: string | null): void {
    if (activeId === this.activeId) return;
    this.activeId = activeId;
    this.container.querySelectorAll<HTMLElement>('.vdt-seg-row').forEach((row) => {
      row.classList.toggle('vdt-active', row.dataset.id === activeId);
    });
  }

  public toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  public get visible(): boolean {
    return this.isVisible;
  }

  public show(): void {
    this.isVisible = true;
    this.container.style.display = 'flex';
    this.render();
    if (this.state.selectedId) this.scrollToRow(this.state.selectedId);
  }

  public hide(): void {
    this.isVisible = false;
    this.container.style.display = 'none';
  }

  public setSubmitting(submitting: boolean, message?: string, kind: 'info' | 'error' = 'info'): void {
    this.isSubmitting = submitting;
    this.statusMessage = message ? { text: message, kind } : null;
    if (this.isVisible) this.render();
  }

  public setStatus(message: string | null, kind: 'info' | 'error' = 'info'): void {
    this.statusMessage = message ? { text: message, kind } : null;
    const status = this.container.querySelector('.vdt-drawer-status');
    if (status) {
      status.textContent = message || '';
      status.className = `vdt-drawer-status ${kind}`;
    }
  }

  // ------------------------------------------------------------- rendering

  public render(): void {
    if (!this.isVisible) return;
    const focus = this.captureFocus();
    this.rendering = true;
    const body = this.container.querySelector('.vdt-drawer-body');
    const scrollTop = body ? body.scrollTop : 0;

    const { segments, categories, undoLabel } = this.state;
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.end_seconds - s.start_seconds), 0);
    const clearArmed = Date.now() < this.clearArmedUntil;

    this.container.innerHTML = `
      <div class="vdt-drawer-header">
        <div class="vdt-drawer-title">
          <span class="vdt-drawer-icon">${ICONS.layers}</span>
          <strong>${segments.length}</strong>
          <span class="vdt-muted">segment${segments.length === 1 ? '' : 's'} · ${total.toFixed(1)}s</span>
          ${segments.length ? `<span class="vdt-saved" title="Saved automatically in this browser">${ICONS.saved}</span>` : ''}
        </div>
        <div class="vdt-drawer-tools">
          ${undoLabel
            ? `<button class="vdt-btn vdt-btn-icon" data-action="undo" title="Undo: ${escapeHtml(undoLabel)}  (Ctrl+Z)" aria-label="Undo">${ICONS.undo}</button>`
            : ''}
          ${segments.length
            ? `<button class="vdt-btn vdt-btn-icon vdt-btn-danger ${clearArmed ? 'vdt-armed' : ''}" data-action="clear"
                 title="${clearArmed ? 'Click again to remove all segments' : 'Remove all segments'}" aria-label="Remove all segments">
                 ${clearArmed ? ICONS.check : ICONS.trash}</button>`
            : ''}
          <button class="vdt-btn vdt-btn-icon" data-action="close" title="Close" aria-label="Close">${ICONS.close}</button>
        </div>
      </div>

      <div class="vdt-drawer-body">
        ${segments.length === 0 ? this.emptyHtml() : segments.map((s, i) => this.rowHtml(s, i, categories)).join('')}
      </div>

      <div class="vdt-drawer-footer">
        <span class="vdt-drawer-status ${this.statusMessage?.kind || 'info'}">${escapeHtml(this.statusMessage?.text || '')}</span>
        <button class="vdt-btn vdt-btn-success" data-action="submit" ${segments.length === 0 || this.isSubmitting ? 'disabled' : ''}
          title="${this.isSubmitting ? 'Sending…' : 'Send segments to server'}" aria-label="Send segments to server">
          ${this.isSubmitting ? `<span class="vdt-spin">${ICONS.loader}</span>` : ICONS.send}<span class="vdt-count">${segments.length}</span>
        </button>
      </div>
    `;

    const newBody = this.container.querySelector('.vdt-drawer-body');
    if (newBody) newBody.scrollTop = scrollTop;
    this.restoreFocus(focus);
    this.rendering = false;
  }

  private emptyHtml(): string {
    return `
      <div class="vdt-empty">
        <span class="vdt-empty-steps">${ICONS.markIn}${ICONS.markOut}${ICONS.check}</span>
        <span>Mark a start <kbd>[</kbd>, an end <kbd>]</kbd>, then save <kbd>Enter</kbd>.</span>
      </div>`;
  }

  private rowHtml(seg: Segment, index: number, categories: Category[]): string {
    const selected = seg.id === this.state.selectedId;
    const category = categories.find((c) => c.id === seg.categories[0]);
    const color = category?.color || '#64748b';
    const duration = (seg.end_seconds - seg.start_seconds).toFixed(2);
    const overlap = this.state.overlaps.has(seg.id);
    const id = escapeHtml(seg.id);

    const options = categories
      .map((c) => `<option value="${escapeHtml(c.id)}" ${seg.categories.includes(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
    const unknownLabel = !category && seg.categories[0]
      ? `<option value="${escapeHtml(seg.categories[0])}" selected>${escapeHtml(seg.categories[0])}</option>`
      : '';

    return `
      <div class="vdt-seg-row ${selected ? 'vdt-selected' : ''} ${seg.id === this.activeId ? 'vdt-active' : ''}" data-id="${id}" style="--vdt-seg-color: ${escapeHtml(color)}">
        <div class="vdt-seg-line" data-action="select" title="${selected ? 'Close editor' : 'Edit this segment'}">
          <span class="vdt-seg-index">${index + 1}</span>
          <span class="vdt-seg-range">
            <span>${formatTime(seg.start_seconds)}</span><span class="vdt-muted">→</span><span>${formatTime(seg.end_seconds)}</span>
          </span>
          <span class="vdt-seg-duration">${duration}s</span>
          ${overlap ? `<span class="vdt-seg-warn" title="Overlaps another segment">${ICONS.alert}</span>` : ''}
          <span class="vdt-spacer"></span>
          <button class="vdt-btn vdt-btn-icon vdt-btn-ghost" data-action="play" title="Play this segment" aria-label="Play this segment">${ICONS.play}</button>
          <button class="vdt-btn vdt-btn-icon vdt-btn-ghost vdt-btn-danger" data-action="delete" title="Delete segment  (Del)" aria-label="Delete segment">${ICONS.trash}</button>
        </div>
        <div class="vdt-seg-label">
          <span class="vdt-dot" style="background: ${escapeHtml(color)};"></span>
          <select data-role="label" aria-label="Segment label">${unknownLabel}${options}</select>
        </div>
        ${selected ? this.editorHtml(seg) : ''}
      </div>`;
  }

  private editorHtml(seg: Segment): string {
    const field = (edge: SegmentEdge, value: number) => `
      <div class="vdt-time-field">
        <span class="vdt-time-caption">${edge === 'start' ? ICONS.markIn : ICONS.markOut}</span>
        <button class="vdt-btn vdt-btn-icon vdt-btn-ghost" data-action="nudge" data-edge="${edge}" data-delta="-1"
          title="Earlier by 0.1 s (Shift: 1 s, Alt: 0.01 s)" aria-label="Earlier">${ICONS.minus}</button>
        <input class="vdt-time-input" data-role="${edge}" value="${formatTime(value)}" spellcheck="false" autocomplete="off"
          title="Type a time (e.g. 1:23.5) · ↑/↓ nudge · Enter apply · Esc revert" aria-label="${edge === 'start' ? 'Start' : 'End'} time" />
        <button class="vdt-btn vdt-btn-icon vdt-btn-ghost" data-action="nudge" data-edge="${edge}" data-delta="1"
          title="Later by 0.1 s (Shift: 1 s, Alt: 0.01 s)" aria-label="Later">${ICONS.plus}</button>
        <button class="vdt-btn vdt-btn-icon" data-action="playhead" data-edge="${edge}"
          title="Set ${edge} to the current playhead  (${edge === 'start' ? '[' : ']'})" aria-label="Set ${edge} to playhead">${ICONS.crosshair}</button>
        <button class="vdt-btn vdt-btn-icon vdt-btn-ghost" data-action="seek-edge" data-edge="${edge}"
          title="Show this frame" aria-label="Go to ${edge}">${ICONS.seek}</button>
      </div>`;
    return `<div class="vdt-seg-editor">${field('start', seg.start_seconds)}${field('end', seg.end_seconds)}</div>`;
  }

  // ---------------------------------------------------------------- events

  private segmentOf(target: HTMLElement): Segment | undefined {
    const id = target.closest<HTMLElement>('.vdt-seg-row')?.dataset.id;
    return this.state.segments.find((s) => s.id === id);
  }

  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    if (target.closest('select, input')) return;
    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (!actionEl || !this.callbacks) return;
    const action = actionEl.dataset.action;
    const seg = this.segmentOf(actionEl);
    const edge = actionEl.dataset.edge as SegmentEdge | undefined;
    const step = (e: Event) => {
      const mouse = e as MouseEvent;
      return mouse.shiftKey ? NUDGE_LARGE : mouse.altKey ? NUDGE_FINE : NUDGE;
    };

    switch (action) {
      case 'close':
        this.hide();
        break;
      case 'undo':
        this.callbacks.onUndo();
        break;
      case 'clear':
        if (Date.now() < this.clearArmedUntil) {
          this.clearArmedUntil = 0;
          this.callbacks.onClearAll();
        } else {
          this.clearArmedUntil = Date.now() + 3000;
          this.render();
          setTimeout(() => this.isVisible && Date.now() >= this.clearArmedUntil && this.render(), 3100);
        }
        break;
      case 'submit':
        void this.callbacks.onSubmit();
        break;
      case 'select':
        if (seg) this.callbacks.onSelect(seg.id === this.state.selectedId ? null : seg.id);
        break;
      case 'play':
        if (seg) this.callbacks.onPlaySegment(seg.id);
        break;
      case 'delete':
        if (seg) this.callbacks.onDelete(seg.id);
        break;
      case 'nudge':
        if (seg && edge) this.callbacks.onNudge(seg.id, edge, Number(actionEl.dataset.delta) * step(event));
        break;
      case 'playhead':
        if (seg && edge) this.callbacks.onSetToPlayhead(seg.id, edge);
        break;
      case 'seek-edge':
        if (seg && edge) this.callbacks.onSeek(edge === 'start' ? seg.start_seconds : seg.end_seconds);
        break;
    }
  }

  private handleChange(event: Event): void {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLSelectElement && target.dataset.role === 'label') {
      const seg = this.segmentOf(target);
      if (seg && target.value) this.callbacks?.onChangeCategory(seg.id, target.value);
    }
  }

  private commitInput(input: HTMLInputElement): void {
    const seg = this.segmentOf(input);
    const edge = input.dataset.role as SegmentEdge;
    if (!seg || !this.callbacks) return;
    const current = edge === 'start' ? seg.start_seconds : seg.end_seconds;
    const parsed = parseTimeInput(input.value);
    if (parsed === null) {
      this.markInvalid(input, 'Use a time like 1:23.5 or 83.5');
      return;
    }
    if (Math.abs(parsed - current) < 0.0005) {
      input.value = formatTime(current);
      input.classList.remove('vdt-invalid');
      return;
    }
    const error = this.callbacks.onSetTime(seg.id, edge, parsed);
    if (error) this.markInvalid(input, error);
  }

  private markInvalid(input: HTMLInputElement, message: string): void {
    input.classList.add('vdt-invalid');
    input.title = message;
    this.setStatus(message, 'error');
  }

  private handleKeydown(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('vdt-time-input')) return;
    const seg = this.segmentOf(input);
    const edge = input.dataset.role as SegmentEdge;
    if (!seg || !this.callbacks) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitInput(input);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.value = formatTime(edge === 'start' ? seg.start_seconds : seg.end_seconds);
      input.classList.remove('vdt-invalid');
      this.setStatus(null);
      input.blur();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const step = event.shiftKey ? NUDGE_LARGE : event.altKey ? NUDGE_FINE : NUDGE;
      this.callbacks.onNudge(seg.id, edge, event.key === 'ArrowUp' ? step : -step);
    }
  }

  private handleFocusOut(event: FocusEvent): void {
    const input = event.target as HTMLInputElement;
    if (this.rendering) return;
    if (input instanceof HTMLInputElement && input.classList.contains('vdt-time-input') && input.isConnected) {
      this.commitInput(input);
    }
  }

  // ----------------------------------------------------------- focus/scroll

  private captureFocus(): { id: string; selector: string; } | null {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !this.container.contains(active)) return null;
    const id = active.closest<HTMLElement>('.vdt-seg-row')?.dataset.id || '';
    const selector = (['role', 'action', 'edge', 'delta'] as const)
      .filter((key) => active.dataset[key])
      .map((key) => `[data-${key}="${CSS.escape(active.dataset[key] as string)}"]`)
      .join('');
    return selector ? { id, selector } : null;
  }

  private restoreFocus(focus: ReturnType<PlayerDrawer['captureFocus']>): void {
    if (!focus) return;
    const scope = focus.id ? this.container.querySelector(`.vdt-seg-row[data-id="${CSS.escape(focus.id)}"]`) : this.container;
    const element = scope?.querySelector<HTMLElement>(focus.selector);
    if (!element) return;
    element.focus({ preventScroll: true });
    if (element instanceof HTMLInputElement) element.select();
  }

  private scrollToRow(id: string): void {
    const row = this.container.querySelector<HTMLElement>(`.vdt-seg-row[data-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  public destroy(): void {
    this.container.remove();
  }
}
