import { Category, DetectedSource, Segment, VideoQuality } from '../types';
import { formatTime } from '../utils/time';
import { ICONS, escapeHtml } from './icons';


export class PlayerBar {
  private container: HTMLDivElement;
  private videoEl: HTMLVideoElement;
  private playerParent: HTMLElement;

  private activeSource: DetectedSource | null = null;
  private categories: Category[] = [];
  private segments: Segment[] = [];
  private selectedCategoryId: string | null = null;
  private selectedQuality: VideoQuality | null = null;

  private startMarker: number | null = null;
  private endMarker: number | null = null;
  private editingSegmentId: string | null = null;
  private isPinned: boolean = true;
  private isSubmitting: boolean = false;

  private openPopover: 'quality' | 'category' | null = null;

  private onMarkStartRequest?: (time: number) => void;
  private onMarkEndRequest?: (time: number) => void;
  private onSaveSegmentRequest?: () => void;
  private onResetMarkersRequest?: () => void;
  private onToggleDrawerRequest?: () => void;
  private onSubmitRequest?: () => Promise<void>;
  private onQualityChangeRequest?: (quality: VideoQuality) => void;
  private onCategoryChangeRequest?: (categoryId: string) => void;
  private onCreateCategoryRequest?: (name: string) => void;
  private onPlayToggleRequest?: () => void;
  private onSeekRequest?: (time: number) => void;
  private onStepFrameRequest?: (direction: -1 | 1) => void;
  private onDeleteEditingRequest?: () => void;

  private isDraggingSeek: boolean = false;

  constructor(videoEl: HTMLVideoElement, playerParent: HTMLElement) {
    this.videoEl = videoEl;
    this.playerParent = playerParent;
    
    this.container = document.createElement('div');
    this.container.className = 'vdt-player-bar vdt-visible';
    
    const pos = window.getComputedStyle(this.playerParent).position;
    if (pos === 'static') {
      this.playerParent.style.position = 'relative';
    }

    this.playerParent.appendChild(this.container);

    document.addEventListener('click', (e) => {
      // Handle popover outside clicks
      const target = e.target as HTMLElement;
      if (!target.closest('.vdt-popover-container')) {
        if (this.openPopover !== null) {
          this.openPopover = null;
          this.render();
        }
      }

      // Bypass click-stealing ad overlays using capture phase
      const barRect = this.container.getBoundingClientRect();
      if (
        e.clientX >= barRect.left &&
        e.clientX <= barRect.right &&
        e.clientY >= barRect.top &&
        e.clientY <= barRect.bottom
      ) {
        // Click is physically inside our bar.
        // Let's manually route the click to the actual button underneath
        // We temporarily disable pointer-events on the overlay? No, we just let it bubble
        // Actually, if we are in capture phase, the event target might be the ad overlay!
        if (!this.container.contains(e.target as Node)) {
          // The event target is NOT inside our container (so it's an overlay).
          // We must find what's REALLY underneath.
          
          // 1. Hide the ad overlay temporarily
          const originalDisplay = (e.target as HTMLElement).style.display;
          (e.target as HTMLElement).style.display = 'none';
          
          // 2. Find the element at these coordinates
          const realTarget = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
          
          // 3. Restore the ad overlay
          (e.target as HTMLElement).style.display = originalDisplay;

          // 4. If the real target is inside our container, simulate click and stop this one
          if (realTarget && this.container.contains(realTarget)) {
            e.stopPropagation();
            e.preventDefault();
            realTarget.click();
          }
        }
      }
    }, true); // useCapture = true
  }

  public setCallbacks(callbacks: {
    onMarkStart: (time: number) => void;
    onMarkEnd: (time: number) => void;
    onSaveSegment: () => void;
    onResetMarkers: () => void;
    onToggleDrawer: () => void;
    onSubmit: () => Promise<void>;
    onQualityChange: (quality: VideoQuality) => void;
    onCategoryChange: (categoryId: string) => void;
    onCreateCategory: (name: string) => void;
    onPlayToggle: () => void;
    onSeek: (time: number) => void;
    onStepFrame: (direction: -1 | 1) => void;
    onDeleteEditing: () => void;
  }): void {
    this.onStepFrameRequest = callbacks.onStepFrame;
    this.onDeleteEditingRequest = callbacks.onDeleteEditing;
    this.onMarkStartRequest = callbacks.onMarkStart;
    this.onMarkEndRequest = callbacks.onMarkEnd;
    this.onSaveSegmentRequest = callbacks.onSaveSegment;
    this.onResetMarkersRequest = callbacks.onResetMarkers;
    this.onToggleDrawerRequest = callbacks.onToggleDrawer;
    this.onSubmitRequest = callbacks.onSubmit;
    this.onQualityChangeRequest = callbacks.onQualityChange;
    this.onCategoryChangeRequest = callbacks.onCategoryChange;
    this.onCreateCategoryRequest = callbacks.onCreateCategory;
    this.onPlayToggleRequest = callbacks.onPlayToggle;
    this.onSeekRequest = callbacks.onSeek;
  }

  public updateTime(currentTime: number, duration: number): void {
    if (!this.isPinned) return; 

    const timeDisp = this.container.querySelector('#vdt-time-display');
    if (timeDisp) {
      timeDisp.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }

    if (!this.isDraggingSeek) {
      const seek = this.container.querySelector('#vdt-seek-bar') as HTMLInputElement;
      if (seek && duration > 0) {
        seek.value = (currentTime / duration * 100).toString();
      }
    }
  }

  public syncPlayState(paused: boolean): void {
    if (!this.isPinned) return;
    const btn = this.container.querySelector('#vdt-btn-play');
    if (btn) {
      btn.innerHTML = paused ? ICONS.play : ICONS.pause;
    }
  }

  public updateState(state: Partial<any>): void {
    if (state.source !== undefined) this.activeSource = state.source;
    if (state.categories !== undefined) this.categories = state.categories;
    if (state.segments !== undefined) this.segments = state.segments;
    if (state.startMarker !== undefined) this.startMarker = state.startMarker;
    if (state.endMarker !== undefined) this.endMarker = state.endMarker;
    if (state.editingSegmentId !== undefined) this.editingSegmentId = state.editingSegmentId;
    if (state.selectedCategoryId !== undefined) this.selectedCategoryId = state.selectedCategoryId;
    if (state.selectedQuality !== undefined) this.selectedQuality = state.selectedQuality;
    if (state.isSubmitting !== undefined) this.isSubmitting = state.isSubmitting;

    this.render();
  }

  public reparent(newParent: HTMLElement): void {
    this.playerParent = newParent;
    const pos = window.getComputedStyle(this.playerParent).position;
    if (pos === 'static') {
      this.playerParent.style.position = 'relative';
    }
    if (this.container.parentElement !== newParent) {
      newParent.appendChild(this.container);
    }
    this.render();
  }

  private render(): void {
    if (!this.isPinned) {
      this.container.className = 'vdt-collapsed-ball';
      this.container.innerHTML = ICONS.expand;
      this.container.title = 'Show tagging controls';
      this.container.onclick = (e) => {
        e.stopPropagation();
        this.isPinned = true;
        this.render();
      };
      return;
    }

    this.container.className = 'vdt-player-bar vdt-visible';
    this.container.onclick = null;

    const hasSelection = this.startMarker !== null;
    const isEditing = !!this.editingSegmentId;
    const editingIndex = isEditing ? this.segments.findIndex((s) => s.id === this.editingSegmentId) + 1 : 0;
    const editingSegment = isEditing ? this.segments[editingIndex - 1] : undefined;
    const editingColor = this.categories.find((c) => c.id === editingSegment?.categories[0])?.color || '#38bdf8';

    let catName = 'None';
    let catColor = '#94a3b8';
    if (this.selectedCategoryId) {
      const c = this.categories.find((x) => x.id === this.selectedCategoryId);
      if (c) {
        catName = c.name;
        catColor = c.color;
      }
    }

    const qualitiesList = this.activeSource?.qualities || [];
    let currentQualityLabel = 'Auto';
    if (this.selectedQuality) {
      currentQualityLabel = this.selectedQuality.label || `${this.selectedQuality.height}p`;
    }

    const arrowSvg = ICONS.chevronDown;
    const playIcon = this.videoEl.paused ? ICONS.play : ICONS.pause;


    this.container.innerHTML = `
      <div class="vdt-seek-container">
        <input type="range" id="vdt-seek-bar" class="vdt-seek-bar" min="0" max="100" value="${this.videoEl.duration ? (this.videoEl.currentTime / this.videoEl.duration * 100) : 0}" step="0.1" />
      </div>

      <div class="vdt-bar-row">
        <div class="vdt-bar-group">
          <button id="vdt-btn-play" class="vdt-btn vdt-btn-icon" style="color: #fff;" title="Play / pause" aria-label="Play or pause">
            ${playIcon}
          </button>

          <button id="vdt-btn-frame-back" class="vdt-btn vdt-btn-icon vdt-btn-ghost" title="Previous frame  ( , )" aria-label="Previous frame">${ICONS.frameBack}</button>
          <span id="vdt-time-display" class="vdt-time-display">
            ${formatTime(this.videoEl.currentTime)} / ${formatTime(this.videoEl.duration || 0)}
          </span>
          <button id="vdt-btn-frame-fwd" class="vdt-btn vdt-btn-icon vdt-btn-ghost" title="Next frame  ( . )" aria-label="Next frame">${ICONS.frameForward}</button>
          ${editingIndex > 0
            ? `<span class="vdt-editing-chip" style="--vdt-seg-color: ${escapeHtml(editingColor)}" title="Start/end buttons now change segment ${editingIndex}">${ICONS.editing}<span>${editingIndex}</span></span>`
            : ''}

          <button id="vdt-btn-in" class="vdt-btn ${this.startMarker !== null ? 'vdt-btn-in-active' : 'vdt-btn-icon'}" style="margin-left: 8px;" title="Mark segment start  ( [ )" aria-label="Mark segment start">
            ${ICONS.markIn}${this.startMarker !== null ? `<span>${formatTime(this.startMarker)}</span>` : ''}
          </button>
          <button id="vdt-btn-out" class="vdt-btn ${this.endMarker !== null ? 'vdt-btn-out-active' : 'vdt-btn-icon'}" title="Mark segment end  ( ] )" aria-label="Mark segment end">
            ${ICONS.markOut}${this.endMarker !== null ? `<span>${formatTime(this.endMarker)}</span>` : ''}
          </button>
          
          ${
            hasSelection
              ? `<button id="vdt-btn-save" class="vdt-btn vdt-btn-primary vdt-btn-icon" title="${isEditing ? 'Done editing' : 'Save segment'}  (Enter)" aria-label="${isEditing ? 'Done editing' : 'Save segment'}">
                  ${ICONS.check}
                </button>`
              : ''
          }
          
          ${
            hasSelection || isEditing
              ? `<button id="vdt-btn-reset" class="vdt-btn vdt-btn-icon" style="color: #94a3b8;" title="${isEditing ? 'Stop editing' : 'Clear markers'}  (Esc)" aria-label="${isEditing ? 'Stop editing' : 'Clear markers'}">
                  ${ICONS.close}
                </button>`
              : ''
          }
          ${isEditing
            ? `<button id="vdt-btn-delete-editing" class="vdt-btn vdt-btn-icon vdt-btn-danger" title="Delete segment ${editingIndex}  (Del)" aria-label="Delete this segment">${ICONS.trash}</button>`
            : ''}
        </div>

        <div class="vdt-bar-group vdt-bar-group-end">
          <span style="color: #64748b; display: inline-flex;" title="Label for the next segment">${ICONS.tag}</span>
          <div class="vdt-popover-container">
            <div id="vdt-cat-trigger" class="vdt-popover-trigger ${this.openPopover === 'category' ? 'active' : ''}">
              <span class="vdt-dot" style="background: ${catColor};"></span>
              <span>${escapeHtml(catName)}</span>
              <span style="color: #94a3b8; margin-left: 2px;">${arrowSvg}</span>
            </div>

            ${
              this.openPopover === 'category'
                ? `
              <div class="vdt-popover-menu" style="min-width: 170px;">
                ${this.categories
                  .map(
                    (c) => `
                  <div class="vdt-popover-item ${c.id === this.selectedCategoryId ? 'selected' : ''}" data-cat-id="${escapeHtml(c.id)}">
                    <span style="display: flex; align-items: center; gap: 6px;">
                      <span class="vdt-dot" style="background: ${escapeHtml(c.color)};"></span>
                      <span>${escapeHtml(c.name)}</span>
                    </span>
                  </div>
                `
                  )
                  .join('')}
                <form id="vdt-new-cat-form" class="vdt-new-label">
                  <input id="vdt-new-cat-input" maxlength="60" placeholder="New label" aria-label="New label name" autocomplete="off" />
                  <button type="submit" class="vdt-btn vdt-btn-icon vdt-btn-primary" title="Add label" aria-label="Add label">${ICONS.plus}</button>
                </form>
              </div>
            `
                : ''
            }
          </div>

          <div class="vdt-popover-container" style="margin-left: 4px;">
            <div id="vdt-quality-trigger" class="vdt-popover-trigger ${this.openPopover === 'quality' ? 'active' : ''}">
              <span>${escapeHtml(currentQualityLabel)}</span>
              <span style="color: #94a3b8; margin-left: 2px;">${arrowSvg}</span>
            </div>

            ${
              this.openPopover === 'quality'
                ? `
              <div class="vdt-popover-menu vdt-popover-menu-right">
                ${qualitiesList
                  .map((q) => {
                    const isSel = this.selectedQuality?.height === q.height || this.selectedQuality?.variant_url === q.variant_url;
                    return `
                    <div class="vdt-popover-item ${isSel ? 'selected' : ''}" data-q-height="${q.height || 1080}">
                      <span>${escapeHtml(q.label || `${q.height}p`)}</span>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            `
                : ''
            }
          </div>

          <button id="vdt-btn-drawer" class="vdt-btn" style="border-color: #3b82f6; color: #93c5fd; margin-left: 4px;" title="Tagged segments" aria-label="Tagged segments">
            ${ICONS.layers}<span class="vdt-count">${this.segments.length}</span>
          </button>

          <button id="vdt-btn-send" class="vdt-btn vdt-btn-success" ${
            this.segments.length === 0 || this.isSubmitting ? 'disabled' : ''
          } title="${this.isSubmitting ? 'Sending…' : 'Send segments to server'}" aria-label="Send segments to server">
            ${this.isSubmitting ? `<span class="vdt-spin">${ICONS.loader}</span>` : ICONS.send}
          </button>
          
          <button id="vdt-btn-pin" class="vdt-btn vdt-btn-icon" style="color: #94a3b8; margin-left: 4px;" title="Hide tagging controls" aria-label="Hide tagging controls">
            ${ICONS.minimize}
          </button>
        </div>
      </div>
    `;

    this.attachEvents(qualitiesList);
    if (this.openPopover === 'category') {
      (this.container.querySelector('#vdt-new-cat-input') as HTMLInputElement | null)?.focus({ preventScroll: true });
    }
  }

  private attachEvents(qualitiesList: VideoQuality[]): void {
    const seek = this.container.querySelector('#vdt-seek-bar') as HTMLInputElement;
    if (seek) {
      seek.addEventListener('input', () => {
        this.isDraggingSeek = true;
        const val = parseFloat(seek.value);
        if (this.videoEl.duration) {
          const newTime = (val / 100) * this.videoEl.duration;
          const timeDisp = this.container.querySelector('#vdt-time-display');
          if (timeDisp) {
            timeDisp.textContent = `${formatTime(newTime)} / ${formatTime(this.videoEl.duration)}`;
          }
        }
      });
      seek.addEventListener('change', () => {
        this.isDraggingSeek = false;
        const val = parseFloat(seek.value);
        if (this.videoEl.duration) {
          const newTime = (val / 100) * this.videoEl.duration;
          this.onSeekRequest?.(newTime);
        }
      });
    }

    this.container.querySelector('#vdt-btn-play')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onPlayToggleRequest?.();
    });

    this.container.querySelector('#vdt-btn-in')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onMarkStartRequest?.(this.videoEl.currentTime);
    });

    this.container.querySelector('#vdt-btn-out')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onMarkEndRequest?.(this.videoEl.currentTime);
    });

    this.container.querySelector('#vdt-btn-save')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSaveSegmentRequest?.();
    });

    this.container.querySelector('#vdt-btn-reset')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onResetMarkersRequest?.();
    });

    this.container.querySelector('#vdt-cat-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPopover = this.openPopover === 'category' ? null : 'category';
      this.render();
    });

    this.container.querySelectorAll('.vdt-popover-item[data-cat-id]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const catId = item.getAttribute('data-cat-id');
        if (catId) {
          this.selectedCategoryId = catId;
          this.openPopover = null;
          this.onCategoryChangeRequest?.(catId);
          this.render();
        }
      });
    });

    const newLabelForm = this.container.querySelector('#vdt-new-cat-form') as HTMLFormElement | null;
    if (newLabelForm) {
      const input = newLabelForm.querySelector('input') as HTMLInputElement;
      // Typing a name must not trigger the page's or the player's shortcuts.
      for (const type of ['keydown', 'keyup', 'keypress', 'click', 'mousedown']) {
        newLabelForm.addEventListener(type, (e) => e.stopPropagation());
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.openPopover = null;
          this.render();
        }
      });
      newLabelForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        this.openPopover = null;
        this.onCreateCategoryRequest?.(name);
      });
    }

    this.container.querySelector('#vdt-btn-frame-back')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onStepFrameRequest?.(-1);
    });
    this.container.querySelector('#vdt-btn-frame-fwd')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onStepFrameRequest?.(1);
    });
    this.container.querySelector('#vdt-btn-delete-editing')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onDeleteEditingRequest?.();
    });

    this.container.querySelector('#vdt-quality-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPopover = this.openPopover === 'quality' ? null : 'quality';
      this.render();
    });

    this.container.querySelectorAll('.vdt-popover-item[data-q-height]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const h = parseInt(item.getAttribute('data-q-height') || '1080', 10);
        const found = qualitiesList.find((q) => q.height === h);
        const chosen = found || { height: h, label: `${h}p` };
        this.selectedQuality = chosen;
        this.openPopover = null;
        this.onQualityChangeRequest?.(chosen);
        this.render();
      });
    });

    this.container.querySelector('#vdt-btn-drawer')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onToggleDrawerRequest?.();
    });

    this.container.querySelector('#vdt-btn-send')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSubmitRequest?.();
    });

    this.container.querySelector('#vdt-btn-pin')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isPinned = false;
      this.render();
    });
  }

  /** The bar's element, so the segments panel can sit right above it. */
  public get element(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.remove();
  }
}
