import { Category, DetectedSource, Segment, VideoQuality } from '../types';
import { formatTime } from '../utils/time';

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

    // Close popovers if clicking outside
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.vdt-popover-container')) {
        if (this.openPopover !== null) {
          this.openPopover = null;
          this.render();
        }
      }
    });

    // Don't pause video when clicking controls
    this.container.addEventListener('click', (e) => e.stopPropagation());
    this.container.addEventListener('mousedown', (e) => e.stopPropagation());
    this.container.addEventListener('dblclick', (e) => e.stopPropagation());

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
  }): void {
    this.onMarkStartRequest = callbacks.onMarkStart;
    this.onMarkEndRequest = callbacks.onMarkEnd;
    this.onSaveSegmentRequest = callbacks.onSaveSegment;
    this.onResetMarkersRequest = callbacks.onResetMarkers;
    this.onToggleDrawerRequest = callbacks.onToggleDrawer;
    this.onSubmitRequest = callbacks.onSubmit;
    this.onQualityChangeRequest = callbacks.onQualityChange;
    this.onCategoryChangeRequest = callbacks.onCategoryChange;
    this.onCreateCategoryRequest = callbacks.onCreateCategory;
  }

  public updateTime(_currentTime: number, _duration: number): void {
    // Currently relying on native player for time, but keeping API for compatibility
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

  private render(): void {
    const hasSelection = this.startMarker !== null;
    const isEditing = !!this.editingSegmentId;

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

    const arrowSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    this.container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px;">
        <button id="vdt-btn-in" class="vdt-btn" title="Mark Start [">
          [ In: ${this.startMarker !== null ? formatTime(this.startMarker) : '--:--'}
        </button>
        <button id="vdt-btn-out" class="vdt-btn" title="Mark End ]">
          ] Out: ${this.endMarker !== null ? formatTime(this.endMarker) : '--:--'}
        </button>
        
        ${
          hasSelection
            ? `<button id="vdt-btn-save" class="vdt-btn vdt-btn-primary" title="Save Segment">
                ${isEditing ? 'Update' : 'Save'}
              </button>`
            : ''
        }
        
        ${
          hasSelection || isEditing
            ? `<button id="vdt-btn-reset" class="vdt-btn" style="padding: 5px 8px; color: #94a3b8;" title="Cancel selection (Esc)">
                ${isEditing ? 'Cancel' : 'Clear'}
              </button>`
            : ''
        }
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="color: #64748b; font-size: 10px;">Label:</span>
        <div class="vdt-popover-container">
          <div id="vdt-cat-trigger" class="vdt-popover-trigger ${this.openPopover === 'category' ? 'active' : ''}">
            <span class="vdt-dot" style="background: ${catColor};"></span>
            <span>${catName}</span>
            <span style="color: #94a3b8; margin-left: 2px;">${arrowSvg}</span>
          </div>

          ${
            this.openPopover === 'category'
              ? `
            <div class="vdt-popover-menu" style="min-width: 170px;">
              ${this.categories
                .map(
                  (c) => `
                <div class="vdt-popover-item ${c.id === this.selectedCategoryId ? 'selected' : ''}" data-cat-id="${c.id}">
                  <span style="display: flex; align-items: center; gap: 6px;">
                    <span class="vdt-dot" style="background: ${c.color};"></span>
                    <span>${c.name}</span>
                  </span>
                </div>
              `
                )
                .join('')}
              <div id="vdt-btn-new-cat" class="vdt-popover-item" style="border-top: 1px solid #334155; margin-top: 4px; padding-top: 6px; color: #38bdf8; font-weight: 600;">
                + Create Label...
              </div>
            </div>
          `
              : ''
          }
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <div class="vdt-popover-container">
          <div id="vdt-quality-trigger" class="vdt-popover-trigger ${this.openPopover === 'quality' ? 'active' : ''}">
            <span>Quality: ${currentQualityLabel}</span>
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
                    <span>${q.label || `${q.height}p`}</span>
                  </div>
                `;
                })
                .join('')}
            </div>
          `
              : ''
          }
        </div>

        <button id="vdt-btn-drawer" class="vdt-btn" style="border-color: #3b82f6; color: #93c5fd;" title="Segments">
          Segments (${this.segments.length})
        </button>

        <button id="vdt-btn-send" class="vdt-btn vdt-btn-success" ${
          this.segments.length === 0 || this.isSubmitting ? 'disabled' : ''
        } title="Submit to server">
          ${this.isSubmitting ? 'Sending...' : 'Send'}
        </button>
        
        <button id="vdt-btn-pin" class="vdt-btn" style="padding: 5px 7px; color: ${this.isPinned ? '#38bdf8' : '#94a3b8'}; font-size: 10px;" title="Toggle UI Visibility">
          ${this.isPinned ? 'Visible' : 'Hidden'}
        </button>
      </div>
    `;

    this.attachEvents(qualitiesList);
    
    if (!this.isPinned) {
        this.container.classList.remove('vdt-visible');
        this.container.classList.add('vdt-hidden');
    } else {
        this.container.classList.remove('vdt-hidden');
        this.container.classList.add('vdt-visible');
    }
  }

  private attachEvents(qualitiesList: VideoQuality[]): void {
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

    this.container.querySelector('#vdt-btn-new-cat')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPopover = null;
      const newLabel = prompt('Enter new label name:');
      if (newLabel && newLabel.trim()) {
        this.onCreateCategoryRequest?.(newLabel.trim());
      }
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
      this.isPinned = !this.isPinned;
      this.render();
    });
  }

  public destroy(): void {
    this.container.remove();
  }
}
