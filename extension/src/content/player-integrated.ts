import { Category, DetectedSource, Segment, VideoQuality } from '../types';
import { PlayerAdapter } from './player-adapter';
import { PlayerTimeline } from './player-timeline';
import { PlayerBar } from './player-bar';
import { PlayerDrawer } from './player-drawer';
import { injectPlayerStyles } from './player-styles';
import { generateId } from '../utils/uuid';
import { StorageService } from '../services/storage';

const PALETTE = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4'];

export class PlayerIntegratedController {
  private videoEl: HTMLVideoElement;
  private adapter: PlayerAdapter;
  private playerParent: HTMLElement;

  private timeline: PlayerTimeline;
  private bar: PlayerBar;
  private drawer: PlayerDrawer;

  private activeSource: DetectedSource | null = null;
  private categories: Category[] = [];
  private segments: Segment[] = [];
  private selectedCategoryId: string = 'person_walking';
  private selectedQuality: VideoQuality | null = null;

  private startMarker: number | null = null;
  private endMarker: number | null = null;
  private editingSegmentId: string | null = null;
  private isSubmitting: boolean = false;

  constructor(videoEl: HTMLVideoElement, index: number) {
    this.videoEl = videoEl;
    this.adapter = new PlayerAdapter(videoEl, index);

    const jwContainer = this.videoEl.closest('.jwplayer') as HTMLElement;
    this.playerParent = jwContainer || this.videoEl.parentElement || document.body;

    injectPlayerStyles();

    this.timeline = new PlayerTimeline(this.videoEl);
    this.bar = new PlayerBar(this.videoEl, this.playerParent);
    this.drawer = new PlayerDrawer(this.videoEl, this.playerParent);

    this.bindCallbacks();
    this.bindAdapterEvents();
    this.bindKeyboardShortcuts();
    this.loadPersistedData();
    this.setupFullscreenListener();
  }

  private setupFullscreenListener(): void {
    const handleFullscreen = () => {
      const fsElement = document.fullscreenElement as HTMLElement;
      if (fsElement) {
        // We entered fullscreen. Move UI to the fullscreen element.
        this.bar.reparent(fsElement);
        this.drawer.reparent(fsElement);
        this.timeline.reparent(fsElement); // if timeline supports it
      } else {
        // Exited fullscreen. Move UI back to original parent.
        this.bar.reparent(this.playerParent);
        this.drawer.reparent(this.playerParent);
        this.timeline.reparent(this.playerParent); // if timeline supports it
      }
    };
    
    document.addEventListener('fullscreenchange', handleFullscreen);
    this.videoEl.addEventListener('webkitbeginfullscreen', handleFullscreen); // Safari fallback
  }

  private async loadPersistedData(): Promise<void> {
    this.categories = await StorageService.getCategories();
    if (this.categories.length > 0) {
      this.selectedCategoryId = this.categories[0].id;
    }
    this.syncComponents();
  }

  private bindCallbacks(): void {
    // Timeline seek / edit request
    this.timeline.setOnSeek((t) => {
      this.adapter.seek(t);
      const match = this.segments.find((s) => s.start_seconds === t);
      if (match) {
        this.loadSegmentForEditing(match.id);
      }
    });

    // Bar callbacks
    this.bar.setCallbacks({
      onMarkStart: (t) => this.markStart(t),
      onMarkEnd: (t) => this.markEnd(t),
      onSaveSegment: () => this.saveSegment(),
      onResetMarkers: () => this.resetMarkers(),
      onToggleDrawer: () => this.drawer.toggle(),
      onSubmit: () => this.submitJob(),
      onQualityChange: (q) => {
        this.selectedQuality = q;
      },
      onCategoryChange: (catId) => {
        this.selectedCategoryId = catId;
        // If editing a segment, update its category immediately
        if (this.editingSegmentId) {
          this.updateSegmentCategory(this.editingSegmentId, catId);
        }
      },
      onCreateCategory: (name) => {
        this.createNewCategory(name);
      },
    });

    // Drawer callbacks
    this.drawer.setCallbacks({
      onSeek: (t) => this.adapter.seek(t),
      onEdit: (id) => this.loadSegmentForEditing(id),
      onChangeCategory: (segId, catId) => this.updateSegmentCategory(segId, catId),
      onDelete: (id) => this.deleteSegment(id),
      onClearAll: () => this.clearAllSegments(),
      onSubmit: () => this.submitJob(),
    });
  }

  private bindAdapterEvents(): void {
    this.adapter.onTimeUpdate((currentTime, duration) => {
      this.timeline.updateTime(currentTime, duration);
      this.bar.updateTime(currentTime, duration);
    });
  }

  private bindKeyboardShortcuts(): void {
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            target.getAttribute('role') === 'textbox')
        ) {
          return;
        }

        let handled = false;
        
        // Use e.code to support non-English (e.g. Arabic) keyboard layouts!
        if (e.code === 'BracketLeft' || e.code === 'KeyI') {
          e.preventDefault();
          this.markStart(this.videoEl.currentTime);
          handled = true;
        } else if (e.code === 'BracketRight' || e.code === 'KeyO') {
          e.preventDefault();
          this.markEnd(this.videoEl.currentTime);
          handled = true;
        } else if (e.code === 'Comma') {
          e.preventDefault();
          this.adapter.seek(Math.max(0, this.videoEl.currentTime - 0.033));
          handled = true;
        } else if (e.code === 'Period') {
          e.preventDefault();
          this.adapter.seek(this.videoEl.currentTime + 0.033);
          handled = true;
        } else if (e.code === 'Enter') {
          // Allow submitting from shortcuts
          e.preventDefault();
          this.saveSegment();
          handled = true;
        } else if (e.code === 'Escape') {
          this.resetMarkers();
          handled = true;
        }

        if (handled) {
          e.stopPropagation();
        }
      },
      true // Capture phase to beat custom players
    );
  }

  public setSource(source: DetectedSource): void {
    this.activeSource = source;
    if (source.qualities && source.qualities.length > 0 && !this.selectedQuality) {
      this.selectedQuality = source.qualities[0];
    }
    this.syncComponents();
  }

  public setCategories(categories: Category[]): void {
    this.categories = categories;
    if (!this.categories.some((c) => c.id === this.selectedCategoryId) && this.categories.length > 0) {
      this.selectedCategoryId = this.categories[0].id;
    }
    this.syncComponents();
  }

  public async createNewCategory(name: string): Promise<void> {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || generateId('cat');
    const existing = this.categories.find((c) => c.id === id || c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      this.selectedCategoryId = existing.id;
      this.syncComponents();
      return;
    }

    const color = PALETTE[this.categories.length % PALETTE.length];
    const newCat: Category = {
      id,
      name,
      color,
    };

    this.categories.push(newCat);
    this.selectedCategoryId = id;
    await StorageService.saveCategories(this.categories);

    // If editing a segment, assign this new category
    if (this.editingSegmentId) {
      this.updateSegmentCategory(this.editingSegmentId, id);
    }

    this.syncComponents();
  }

  public setSegments(segments: Segment[]): void {
    this.segments = segments;
    this.syncComponents();
  }

  public markStart(time: number): void {
    this.startMarker = Math.round(time * 100) / 100;
    this.timeline.setMarkers(this.startMarker, this.endMarker);
    this.bar.updateState({ startMarker: this.startMarker });
  }

  public markEnd(time: number): void {
    this.endMarker = Math.round(time * 100) / 100;
    this.timeline.setMarkers(this.startMarker, this.endMarker);
    this.bar.updateState({ endMarker: this.endMarker });
  }

  public loadSegmentForEditing(segmentId: string): void {
    const seg = this.segments.find((s) => s.id === segmentId);
    if (!seg) return;

    this.editingSegmentId = seg.id;
    this.startMarker = seg.start_seconds;
    this.endMarker = seg.end_seconds;
    this.selectedCategoryId = seg.categories[0] || this.selectedCategoryId;

    this.timeline.setMarkers(this.startMarker, this.endMarker);
    this.bar.updateState({
      startMarker: this.startMarker,
      endMarker: this.endMarker,
      editingSegmentId: this.editingSegmentId,
      selectedCategoryId: this.selectedCategoryId,
    });
  }

  public updateSegmentCategory(segmentId: string, newCategoryId: string): void {
    const seg = this.segments.find((s) => s.id === segmentId);
    if (seg) {
      seg.categories = [newCategoryId];
      this.syncComponents();

      chrome.runtime.sendMessage({
        type: 'OVERLAY_SEGMENTS_UPDATED',
        payload: { segments: this.segments, sourceId: this.activeSource?.id },
      }).catch(() => {});
    }
  }

  public resetMarkers(): void {
    this.startMarker = null;
    this.endMarker = null;
    this.editingSegmentId = null;
    this.timeline.setMarkers(null, null);
    this.bar.updateState({ startMarker: null, endMarker: null, editingSegmentId: null });
  }

  public saveSegment(): void {
    if (this.startMarker === null) {
      alert('Please mark segment start first using [ In button or [ shortcut.');
      return;
    }

    const end = this.endMarker !== null ? this.endMarker : this.videoEl.currentTime;
    if (end <= this.startMarker) {
      alert('Segment end time must be greater than start time.');
      return;
    }

    if (this.editingSegmentId) {
      // Update existing segment
      const existing = this.segments.find((s) => s.id === this.editingSegmentId);
      if (existing) {
        existing.start_seconds = this.startMarker;
        existing.end_seconds = Math.round(end * 100) / 100;
        existing.categories = [this.selectedCategoryId];
      }
      this.resetMarkers();
      this.syncComponents();
    } else {
      // Create new segment
      const newSeg: Segment = {
        id: generateId('seg'),
        start_seconds: this.startMarker,
        end_seconds: Math.round(end * 100) / 100,
        categories: [this.selectedCategoryId],
      };
      this.segments.push(newSeg);
      this.resetMarkers();
      this.syncComponents();
    }

    chrome.runtime.sendMessage({
      type: 'OVERLAY_SEGMENTS_UPDATED',
      payload: { segments: this.segments, sourceId: this.activeSource?.id },
    }).catch(() => {});
  }

  public deleteSegment(id: string): void {
    this.segments = this.segments.filter((s) => s.id !== id);
    if (this.editingSegmentId === id) {
      this.resetMarkers();
    }
    this.syncComponents();

    chrome.runtime.sendMessage({
      type: 'OVERLAY_SEGMENTS_UPDATED',
      payload: { segments: this.segments, sourceId: this.activeSource?.id },
    }).catch(() => {});
  }

  public clearAllSegments(): void {
    this.segments = [];
    this.resetMarkers();
    this.syncComponents();

    chrome.runtime.sendMessage({
      type: 'OVERLAY_SEGMENTS_UPDATED',
      payload: { segments: this.segments, sourceId: this.activeSource?.id },
    }).catch(() => {});
  }

  private syncComponents(): void {
    this.timeline.setSegments(this.segments);
    this.timeline.setCategories(this.categories);
    this.timeline.setMarkers(this.startMarker, this.endMarker);

    this.bar.updateState({
      source: this.activeSource,
      categories: this.categories,
      segments: this.segments,
      startMarker: this.startMarker,
      endMarker: this.endMarker,
      editingSegmentId: this.editingSegmentId,
      selectedCategoryId: this.selectedCategoryId,
      selectedQuality: this.selectedQuality,
      isSubmitting: this.isSubmitting,
    });

    this.drawer.updateData(this.segments, this.categories);
  }

  public async loadImportedSegments(importedSegments: any[]): Promise<boolean> {
    try {
      // Transform imported segments to our format
      const mappedSegments = importedSegments.map(s => ({
        id: 'seg_' + Math.random().toString(36).substr(2, 9),
        start_seconds: s.start_seconds,
        end_seconds: s.end_seconds,
        categories: s.categories || (s.category ? [s.category] : []),
        created_at: Date.now()
      }));

      // Append to current segments
      this.segments = [...this.segments, ...mappedSegments];
      
      // Update the Video Player UI immediately
      this.syncComponents();
      this.drawer.updateData(this.segments, this.categories);
      
      // Save locally
      chrome.runtime.sendMessage({
        type: 'OVERLAY_SEGMENTS_UPDATED',
        payload: { segments: this.segments, sourceId: this.activeSource?.id },
      }).catch(() => {});

      return true;
    } catch (err: any) {
      console.error('Load imported segments error:', err);
      return false;
    }
  }

  public async submitJob(): Promise<void> {
    if (this.segments.length === 0) {
      alert('Please mark and save at least one segment first.');
      return;
    }

    const mediaUrl = this.activeSource?.media_url || this.videoEl.currentSrc || this.videoEl.src;
    if (!mediaUrl) {
      alert('No video media URL identified for export.');
      return;
    }

    this.isSubmitting = true;
    this.bar.updateState({ isSubmitting: true });
    this.drawer.setSubmitting(true, 'Submitting job to server...');

    const payload = {
      schema_version: '2.0',
      source: {
        page_url: window.location.href,
        media_url: mediaUrl,
        type: this.activeSource?.type || 'hls',
        duration_seconds: this.videoEl.duration || this.activeSource?.duration_seconds,
        headers: this.activeSource?.headers || { Referer: window.location.href },
      },
      quality: {
        height: this.selectedQuality?.height || 1080,
        variant_url: this.selectedQuality?.variant_url,
      },
      segments: this.segments.map((s) => ({
        id: s.id,
        start_seconds: s.start_seconds,
        end_seconds: s.end_seconds,
        categories: s.categories,
      })),
      categories_metadata: this.categories,
    };

    chrome.runtime.sendMessage(
      {
        type: 'SUBMIT_JOB_FROM_OVERLAY',
        payload,
      },
      (res) => {
        this.isSubmitting = false;
        this.bar.updateState({ isSubmitting: false });

        if (res && res.ok) {
          const successMsg = `Submitted: ${res.job_id} (${res.status})`;
          this.drawer.setSubmitting(false, successMsg);
        } else {
          const errText = res?.error || 'Could not connect to backend server';
          this.drawer.setSubmitting(false, `Error: ${errText}`);
          alert(`Submission Error: ${errText}`);
        }
      }
    );
  }

  public destroy(): void {
    this.timeline.destroy();
    this.bar.destroy();
    this.drawer.destroy();
  }
}
