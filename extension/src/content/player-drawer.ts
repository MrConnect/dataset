import { Category, Segment } from '../types';
import { formatTime } from '../utils/time';

export class PlayerDrawer {
  private container: HTMLDivElement;
  private playerParent: HTMLElement;

  private segments: Segment[] = [];
  private categories: Category[] = [];
  private isVisible: boolean = false;
  private isSubmitting: boolean = false;
  private statusMessage: string | null = null;

  private onSeekRequest?: (time: number) => void;
  private onEditRequest?: (segmentId: string) => void;
  private onChangeCategoryRequest?: (segmentId: string, categoryId: string) => void;
  private onDeleteRequest?: (segmentId: string) => void;
  private onClearAllRequest?: () => void;
  private onSubmitRequest?: () => Promise<void>;

  constructor(_videoEl: HTMLVideoElement, playerParent: HTMLElement) {
    this.playerParent = playerParent;
    this.container = document.createElement('div');
    this.container.className = 'vdt-segments-drawer';
    this.container.style.display = 'none';
    
    // Stop propagation so clicking drawer doesn't pause custom players
    this.container.addEventListener('click', (e) => e.stopPropagation());
    this.container.addEventListener('dblclick', (e) => e.stopPropagation());
    this.container.addEventListener('mousedown', (e) => e.stopPropagation());

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

  public setCallbacks(callbacks: {
    onSeek: (time: number) => void;
    onEdit: (id: string) => void;
    onChangeCategory: (segmentId: string, categoryId: string) => void;
    onDelete: (id: string) => void;
    onClearAll: () => void;
    onSubmit: () => Promise<void>;
  }): void {
    this.onSeekRequest = callbacks.onSeek;
    this.onEditRequest = callbacks.onEdit;
    this.onChangeCategoryRequest = callbacks.onChangeCategory;
    this.onDeleteRequest = callbacks.onDelete;
    this.onClearAllRequest = callbacks.onClearAll;
    this.onSubmitRequest = callbacks.onSubmit;
  }

  public updateData(segments: Segment[], categories: Category[]): void {
    this.segments = segments;
    this.categories = categories;
    if (this.isVisible) {
      this.render();
    }
  }

  public toggle(): void {
    this.isVisible = !this.isVisible;
    this.container.style.display = this.isVisible ? 'flex' : 'none';
    if (this.isVisible) {
      this.render();
    }
  }

  public show(): void {
    this.isVisible = true;
    this.container.style.display = 'flex';
    this.render();
  }

  public hide(): void {
    this.isVisible = false;
    this.container.style.display = 'none';
  }

  public setSubmitting(submitting: boolean, message?: string): void {
    this.isSubmitting = submitting;
    this.statusMessage = message || null;
    this.render();
  }

  public render(): void {
    if (!this.isVisible) return;

    let totalDuration = 0;
    this.segments.forEach((s) => {
      totalDuration += Math.max(0, s.end_seconds - s.start_seconds);
    });

    this.container.innerHTML = `
      <div class="vdt-drawer-header">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-weight: 700; color: #38bdf8; font-size: 11px;">Tagged Segments</span>
          <span style="background: #1e3a8a; color: #bfdbfe; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 10px;">
            ${this.segments.length}
          </span>
          <span style="color: #64748b; font-size: 10px;">(${totalDuration.toFixed(1)}s total)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          ${
            this.segments.length > 0
              ? `<button id="vdt-drawer-clear" style="background: none; border: none; color: #ef4444; font-size: 10px; cursor: pointer; text-decoration: underline;">Clear All</button>`
              : ''
          }
          <button id="vdt-drawer-close" style="background: none; border: none; color: #94a3b8; font-size: 12px; cursor: pointer; padding: 2px 5px;">Close</button>
        </div>
      </div>

      <div class="vdt-drawer-body">
        ${
          this.segments.length === 0
            ? `<div style="text-align: center; color: #64748b; padding: 24px 10px; font-size: 11px;">
                No segments added yet.<br/>Use <strong>[</strong> to mark start, <strong>]</strong> for end, and <strong>Tag Segment</strong> to save.
               </div>`
            : this.segments
                .map((seg) => {
                  const cat = this.categories.find((c) => c.id === seg.categories[0]);
                  const catColor = cat ? cat.color : '#3b82f6';
                  const segDur = (seg.end_seconds - seg.start_seconds).toFixed(1);

                  return `
                    <div class="vdt-segment-card" data-seg-id="${seg.id}">
                      <div style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
                        <div style="display: flex; align-items: center; gap: 5px;">
                          <span style="font-weight: 700; color: #e2e8f0; font-family: monospace;">
                            ${formatTime(seg.start_seconds)} - ${formatTime(seg.end_seconds)}
                          </span>
                          <span style="color: #64748b; font-size: 10px;">(${segDur}s)</span>
                        </div>

                        <!-- Direct Label/Category Editor for this segment -->
                        <div style="display: flex; align-items: center; gap: 6px;">
                          <span class="vdt-dot" style="background: ${catColor};"></span>
                          <select class="vdt-seg-cat-select" data-seg-id="${seg.id}" style="
                            background: #0f172a;
                            border: 1px solid #475569;
                            color: #f8fafc;
                            border-radius: 4px;
                            padding: 2px 6px;
                            font-size: 10px;
                            cursor: pointer;
                            outline: none;
                          ">
                            ${this.categories
                              .map(
                                (c) => `
                              <option value="${c.id}" ${seg.categories.includes(c.id) ? 'selected' : ''}>
                                ${c.name}
                              </option>
                            `
                              )
                              .join('')}
                          </select>
                        </div>
                      </div>

                      <div style="display: flex; align-items: center; gap: 4px;">
                        <button class="vdt-btn vdt-btn-edit" data-id="${seg.id}" style="padding: 3px 6px; font-size: 10px;" title="Edit segment in player bar">
                          Edit
                        </button>
                        <button class="vdt-btn vdt-btn-seek" data-time="${seg.start_seconds}" style="padding: 3px 6px; font-size: 10px;" title="Seek to start">
                          Seek
                        </button>
                        <button class="vdt-btn vdt-btn-del" data-id="${seg.id}" style="padding: 3px 6px; font-size: 10px; color: #ef4444; border-color: rgba(239, 68, 68, 0.4);" title="Delete segment">
                          Del
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>

      <div style="padding: 8px 12px; background: rgba(30, 41, 59, 0.85); border-top: 1px solid rgba(51, 65, 85, 0.8); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        ${
          this.statusMessage
            ? `<span style="font-size: 10px; color: #38bdf8;">${this.statusMessage}</span>`
            : `<span style="font-size: 10px; color: #94a3b8;">Ready for CVAT export</span>`
        }
        <button id="vdt-drawer-submit" class="vdt-btn vdt-btn-success" style="font-size: 11px; padding: 4px 10px;" ${
          this.segments.length === 0 || this.isSubmitting ? 'disabled' : ''
        }>
          ${this.isSubmitting ? 'Submitting...' : 'Send to Server'}
        </button>
      </div>
    `;

    this.attachEvents();
  }

  private attachEvents(): void {
    // Close button
    this.container.querySelector('#vdt-drawer-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });

    // Clear all
    this.container.querySelector('#vdt-drawer-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Clear all tagged segments for this video?')) {
        this.onClearAllRequest?.();
      }
    });

    // Direct category change on segment card
    this.container.querySelectorAll('.vdt-seg-cat-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const selectEl = sel as HTMLSelectElement;
        const segId = selectEl.getAttribute('data-seg-id');
        const newCatId = selectEl.value;
        if (segId && newCatId) {
          this.onChangeCategoryRequest?.(segId, newCatId);
        }
      });
    });

    // Edit buttons (load segment into player bar)
    this.container.querySelectorAll('.vdt-btn-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (id) {
          this.onEditRequest?.(id);
        }
      });
    });

    // Seek buttons
    this.container.querySelectorAll('.vdt-btn-seek').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = parseFloat(btn.getAttribute('data-time') || '0');
        this.onSeekRequest?.(t);
      });
    });

    // Delete buttons
    this.container.querySelectorAll('.vdt-btn-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (id) {
          this.onDeleteRequest?.(id);
        }
      });
    });

    // Submit button
    this.container.querySelector('#vdt-drawer-submit')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSubmitRequest?.();
    });
  }

  public destroy(): void {
    this.container.remove();
  }
}
