import { Category, Segment } from '../types';
import { formatTime } from '../utils/time';

export class PlayerTimeline {
  private videoEl: HTMLVideoElement;
  private scrubberContainer: HTMLElement | null = null;
  private scrubberLayer: HTMLDivElement | null = null;
  private tooltipEl: HTMLDivElement | null = null;

  private segments: Segment[] = [];
  private categories: Category[] = [];
  private startMarker: number | null = null;
  private endMarker: number | null = null;
  private currentTime: number = 0;
  private duration: number = 0;

  private onSeekCallback?: (time: number) => void;

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
    this.init();
  }

  private init(): void {
    this.locateScrubberContainer();
    if (!this.scrubberContainer) {
      setTimeout(() => this.locateScrubberContainer(), 600);
      setTimeout(() => this.locateScrubberContainer(), 1800);
    }

    // Handle fullscreen changes so scrubber re-aligns
    document.addEventListener('fullscreenchange', () => {
      this.locateScrubberContainer();
      this.render();
    });
    document.addEventListener('webkitfullscreenchange', () => {
      this.locateScrubberContainer();
      this.render();
    });
  }

  public reparent(_newParent: HTMLElement): void {
    // The timeline automatically re-locates the scrubber on fullscreen change, so no manual reparenting needed.
  }

  /**
   * Locates the progress/seek bar element in JWPlayer, VideoJS, or standard HTML5
   */
  public locateScrubberContainer(): HTMLElement | null {
    const parent = this.videoEl.parentElement;

    // 1. Look for JWPlayer time slider
    const jwPlayer =
      (document.fullscreenElement as HTMLElement) ||
      this.videoEl.closest('.jwplayer') ||
      parent?.closest('.jwplayer') ||
      document.querySelector('.jwplayer');

    if (jwPlayer) {
      const jwSlider =
        jwPlayer.querySelector('.jw-slider-time') ||
        jwPlayer.querySelector('.jw-slider-container') ||
        jwPlayer.querySelector('.jw-rail');

      if (jwSlider instanceof HTMLElement) {
        if (this.scrubberContainer !== jwSlider) {
          this.scrubberContainer = jwSlider;
          this.mountLayer();
        }
        return this.scrubberContainer;
      }
    }

    if (!parent) return null;

    // 2. VideoJS progress control
    const vjsBar = parent.querySelector('.vjs-progress-control') || parent.querySelector('.vjs-play-progress');
    if (vjsBar instanceof HTMLElement) {
      if (this.scrubberContainer !== vjsBar) {
        this.scrubberContainer = vjsBar;
        this.mountLayer();
      }
      return this.scrubberContainer;
    }

    // 3. Generic slider
    const genericBar = parent.querySelector('[role="slider"]') || parent.querySelector('.progress-bar');
    if (genericBar instanceof HTMLElement) {
      if (this.scrubberContainer !== genericBar) {
        this.scrubberContainer = genericBar;
        this.mountLayer();
      }
      return this.scrubberContainer;
    }

    return null;
  }

  private mountLayer(): void {
    if (!this.scrubberContainer) return;

    const existing = this.scrubberContainer.querySelector('.vdt-scrubber-layer');
    if (existing instanceof HTMLDivElement) {
      this.scrubberLayer = existing;
      this.tooltipEl = this.scrubberContainer.querySelector('.vdt-scrubber-tooltip');
      return;
    }

    const pos = window.getComputedStyle(this.scrubberContainer).position;
    if (pos === 'static') {
      this.scrubberContainer.style.position = 'relative';
    }

    this.scrubberLayer = document.createElement('div');
    this.scrubberLayer.className = 'vdt-scrubber-layer';
    this.scrubberContainer.appendChild(this.scrubberLayer);

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'vdt-scrubber-tooltip';
    this.tooltipEl.style.display = 'none';
    this.scrubberContainer.appendChild(this.tooltipEl);

    this.render();
  }

  public setOnSeek(cb: (time: number) => void): void {
    this.onSeekCallback = cb;
  }

  public updateTime(current: number, duration: number): void {
    this.currentTime = current;
    this.duration = duration || this.videoEl.duration || 0;

    if (!this.scrubberLayer || !document.contains(this.scrubberLayer)) {
      this.locateScrubberContainer();
    }

    if (this.startMarker !== null) {
      this.updateLiveSelection();
    }
  }

  public setSegments(segments: Segment[]): void {
    this.segments = segments;
    this.render();
  }

  public setCategories(categories: Category[]): void {
    this.categories = categories;
    this.render();
  }

  public setMarkers(start: number | null, end: number | null): void {
    this.startMarker = start;
    this.endMarker = end;
    this.render();
  }

  private updateLiveSelection(): void {
    if (!this.scrubberLayer || !this.duration || this.startMarker === null) return;

    let liveEl = this.scrubberLayer.querySelector('.vdt-timeline-live-range') as HTMLElement;
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.className = 'vdt-timeline-live-range';
      this.scrubberLayer.appendChild(liveEl);
    }

    const endPoint = this.endMarker !== null ? this.endMarker : this.currentTime;
    const minTime = Math.min(this.startMarker, endPoint);
    const maxTime = Math.max(this.startMarker, endPoint);

    const leftPct = Math.max(0, Math.min(100, (minTime / this.duration) * 100));
    const widthPct = Math.max(0.2, Math.min(100 - leftPct, ((maxTime - minTime) / this.duration) * 100));

    liveEl.style.left = `${leftPct}%`;
    liveEl.style.width = `${widthPct}%`;
  }

  public render(): void {
    if (!this.scrubberLayer) {
      this.locateScrubberContainer();
      if (!this.scrubberLayer) return;
    }

    this.scrubberLayer.innerHTML = '';
    const dur = this.duration || this.videoEl.duration || 1;

    // 1. Render all saved segments
    this.segments.forEach((seg) => {
      const leftPct = Math.max(0, Math.min(100, (seg.start_seconds / dur) * 100));
      const widthPct = Math.max(0.4, Math.min(100 - leftPct, ((seg.end_seconds - seg.start_seconds) / dur) * 100));

      const firstCatId = seg.categories[0];
      const catObj = this.categories.find((c) => c.id === firstCatId);
      const catColor = catObj ? catObj.color : '#3b82f6';
      const catName = catObj ? catObj.name : firstCatId || 'Segment';

      const segEl = document.createElement('div');
      segEl.className = 'vdt-timeline-segment';
      segEl.style.left = `${leftPct}%`;
      segEl.style.width = `${widthPct}%`;
      segEl.style.backgroundColor = catColor;
      segEl.setAttribute('data-start', seg.start_seconds.toString());
      segEl.setAttribute('data-id', seg.id);

      // Hover tooltip
      segEl.addEventListener('mouseenter', () => {
        if (!this.tooltipEl) return;
        const durationText = (seg.end_seconds - seg.start_seconds).toFixed(1) + 's';
        this.tooltipEl.innerHTML = `
          <span class="vdt-dot" style="background: ${catColor};"></span>
          <strong>${catName}</strong>
          <span style="color: #94a3b8;">${formatTime(seg.start_seconds)} - ${formatTime(seg.end_seconds)} (${durationText})</span>
        `;
        this.tooltipEl.style.left = `${leftPct + widthPct / 2}%`;
        this.tooltipEl.style.display = 'flex';
      });

      segEl.addEventListener('mouseleave', () => {
        if (this.tooltipEl) this.tooltipEl.style.display = 'none';
      });

      // Click to seek to segment start
      segEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onSeekCallback) {
          this.onSeekCallback(seg.start_seconds);
        } else {
          this.videoEl.currentTime = seg.start_seconds;
        }
      });

      this.scrubberLayer?.appendChild(segEl);
    });

    // 2. Render In-marker Pin (Start)
    if (this.startMarker !== null) {
      const startPct = Math.max(0, Math.min(100, (this.startMarker / dur) * 100));
      const pinStart = document.createElement('div');
      pinStart.className = 'vdt-timeline-pin';
      pinStart.style.left = `${startPct}%`;
      pinStart.style.backgroundColor = '#22c55e';
      pinStart.innerHTML = `
        <span class="vdt-timeline-pin-flag" style="background: #22c55e; color: #022c22;">
          IN ${formatTime(this.startMarker)}
        </span>
      `;
      pinStart.addEventListener('click', (e) => {
        e.stopPropagation();
        this.videoEl.currentTime = this.startMarker!;
      });
      this.scrubberLayer.appendChild(pinStart);
    }

    // 3. Render Out-marker Pin (End)
    if (this.endMarker !== null) {
      const endPct = Math.max(0, Math.min(100, (this.endMarker / dur) * 100));
      const pinEnd = document.createElement('div');
      pinEnd.className = 'vdt-timeline-pin';
      pinEnd.style.left = `${endPct}%`;
      pinEnd.style.backgroundColor = '#ef4444';
      pinEnd.innerHTML = `
        <span class="vdt-timeline-pin-flag" style="background: #ef4444; color: #ffffff;">
          OUT ${formatTime(this.endMarker)}
        </span>
      `;
      pinEnd.addEventListener('click', (e) => {
        e.stopPropagation();
        this.videoEl.currentTime = this.endMarker!;
      });
      this.scrubberLayer.appendChild(pinEnd);
    }

    // 4. Render Active Live Range Strip
    if (this.startMarker !== null) {
      this.updateLiveSelection();
    }
  }

  public destroy(): void {
    this.scrubberLayer?.remove();
    this.tooltipEl?.remove();
    this.scrubberLayer = null;
    this.tooltipEl = null;
  }
}
