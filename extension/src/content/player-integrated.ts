import { Category, DetectedSource, Segment, VideoQuality } from '../types';
import { ICONS } from './icons';
import { PlayerAdapter } from './player-adapter';
import { PlayerTimeline } from './player-timeline';
import { PlayerBar } from './player-bar';
import { PlayerDrawer } from './player-drawer';
import { injectPlayerStyles } from './player-styles';
import { generateId } from '../utils/uuid';
import { formatTime } from '../utils/time';
import { clampTime, findOverlaps, rangeError, roundTime, segmentAt, sortSegments } from './segment-ops';
import { SegmentEdge } from './player-drawer';
import { showOverlayToast } from './overlay-toast';
import { StorageService, normalizeUrl } from '../services/storage';

const PALETTE = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4'];

export class PlayerIntegratedController {
  private videoEl: HTMLVideoElement;
  private adapter: PlayerAdapter;
  private playerParent: HTMLElement;

  private timeline: PlayerTimeline;
  private bar: PlayerBar;
  private drawer: PlayerDrawer;

  private activeSource: DetectedSource | null = null;
  private sourceCandidates: Map<string, DetectedSource> = new Map();
  private readonly handleLoadedMetadata = () => this.handleVideoLoaded();
  /** Which video the current segments belong to (address + length). */
  private videoIdentity: string | null = null;
  private categories: Category[] = [];
  private segments: Segment[] = [];
  private selectedCategoryId: string = 'person_walking';
  private selectedQuality: VideoQuality | null = null;

  private startMarker: number | null = null;
  private endMarker: number | null = null;
  private editingSegmentId: string | null = null;
  private isSubmitting: boolean = false;

  private undoStack: { label: string; key?: string; at: number; segments: Segment[] }[] = [];
  private segmentPlayback = 0;
  private barObserver: ResizeObserver | null = null;

  private autoSaveTimer: any = null;
  private hasRestoredDraft: boolean = false;
  private readonly handleBeforeUnload = () => this.flushAutoSaveSync();
  private readonly handlePageHide = () => this.flushAutoSaveSync();

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
    this.followBarHeight();
    this.bindKeyboardShortcuts();
    this.loadPersistedData();
    this.setupFullscreenListener();
    this.setupAutoSaveLifecycle();
    this.videoEl.addEventListener('loadedmetadata', this.handleLoadedMetadata);
  }

  private setupAutoSaveLifecycle(): void {
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    window.addEventListener('pagehide', this.handlePageHide);
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
    await this.restoreDraftIfNeeded();
    this.syncComponents();
  }

  private bindCallbacks(): void {
    // Clicking a segment on the player's own progress bar selects it.
    this.timeline.setOnSelect((id) => this.selectSegment(id));

    this.bar.setCallbacks({
      onMarkStart: (t) => this.markStart(t),
      onMarkEnd: (t) => this.markEnd(t),
      onSaveSegment: () => this.saveSegment(),
      onResetMarkers: () => this.resetMarkers(),
      onDeleteEditing: () => this.editingSegmentId && this.deleteSegment(this.editingSegmentId),
      onToggleDrawer: () => this.drawer.toggle(),
      onSubmit: () => this.submitJob(),
      onQualityChange: (q) => {
        this.selectedQuality = q;
      },
      onCategoryChange: (catId) => {
        this.selectedCategoryId = catId;
        if (this.editingSegmentId) this.updateSegmentCategory(this.editingSegmentId, catId);
      },
      onCreateCategory: (name) => {
        void this.createNewCategory(name);
      },
      onPlayToggle: () => this.adapter.togglePlay(),
      onSeek: (time: number) => this.adapter.seek(time),
      onStepFrame: (direction) => this.stepFrame(direction),
    });

    this.drawer.setCallbacks({
      onSelect: (id) => this.selectSegment(id),
      onSeek: (t) => this.adapter.seek(t),
      onPlaySegment: (id) => this.playSegment(id),
      onSetTime: (id, edge, seconds) => this.setSegmentTime(id, edge, seconds),
      onSetToPlayhead: (id, edge) => this.setSegmentEdgeToPlayhead(id, edge),
      onNudge: (id, edge, delta) => this.nudgeSegment(id, edge, delta),
      onChangeCategory: (segId, catId) => this.updateSegmentCategory(segId, catId),
      onDelete: (id) => this.deleteSegment(id),
      onClearAll: () => this.clearAllSegments(),
      onUndo: () => this.undo(),
      onSubmit: () => this.submitJob(),
    });
  }

  private followBarHeight(): void {
    const place = () => {
      const bar = this.bar.element;
      const host = bar.offsetParent as HTMLElement | null;
      if (!host || !bar.offsetHeight) return;
      this.drawer.setBottomOffset(host.clientHeight - bar.offsetTop + 8);
    };
    if (typeof ResizeObserver !== 'undefined') {
      this.barObserver = new ResizeObserver(place);
      this.barObserver.observe(this.bar.element);
      this.barObserver.observe(this.playerParent);
    }
    window.setTimeout(place, 0);
  }

  private stepFrame(direction: -1 | 1): void {
    this.adapter.pause();
    this.adapter.seek(Math.max(0, this.videoEl.currentTime + direction * (1 / 30)));
  }

  private bindAdapterEvents(): void {
    this.adapter.onTimeUpdate((currentTime, duration) => {
      this.timeline.updateTime(currentTime, duration);
      this.bar.updateTime(currentTime, duration);
      this.drawer.setPlayhead(segmentAt(this.segments, currentTime)?.id || null);
    });
    this.adapter.onPlayStateChange((paused) => {
      this.bar.syncPlayState(paused);
    });
  }

  private bindKeyboardShortcuts(): void {
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable ||
            target.getAttribute('role') === 'textbox')
        ) {
          return;
        }
        // Enter / Space on one of our own buttons should press that button.
        const onOwnButton = !!target?.closest('.vdt-player-bar button, .vdt-segments-drawer button, .vdt-toast button');
        const hasSelection = this.startMarker !== null || this.editingSegmentId !== null;
        const ctrl = e.ctrlKey || e.metaKey;

        let handled = true;
        // e.code keeps the shortcuts working on non-English (e.g. Arabic) layouts.
        if (!ctrl && (e.code === 'BracketLeft' || e.code === 'KeyI')) {
          this.markStart(this.videoEl.currentTime);
        } else if (!ctrl && (e.code === 'BracketRight' || e.code === 'KeyO')) {
          this.markEnd(this.videoEl.currentTime);
        } else if (!ctrl && e.code === 'Comma') {
          this.stepFrame(-1);
        } else if (!ctrl && e.code === 'Period') {
          this.stepFrame(1);
        } else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && hasSelection && !onOwnButton) {
          this.saveSegment();
        } else if (e.code === 'Escape' && hasSelection) {
          this.resetMarkers();
        } else if ((e.code === 'Delete' || e.code === 'Backspace') && this.editingSegmentId && !onOwnButton) {
          this.deleteSegment(this.editingSegmentId);
        } else if (ctrl && !e.shiftKey && e.code === 'KeyZ' && this.undoStack.length) {
          this.undo();
        } else {
          handled = false;
        }

        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true // Capture phase to beat custom players
    );
  }

  public setSource(source: DetectedSource): void {
    this.sourceCandidates.set(source.media_url, source);
    this.selectBestSource();
  }

  private sourceScore(source: DetectedSource): number {
    const currentSrc = this.videoEl.currentSrc || this.videoEl.src;
    if (currentSrc && !currentSrc.startsWith('blob:') && currentSrc === source.media_url) {
      return 1000;
    }

    const videoDuration = this.videoEl.duration;
    const sourceDuration = source.duration_seconds;
    if (Number.isFinite(videoDuration) && videoDuration > 0 && Number.isFinite(sourceDuration) && sourceDuration! > 0) {
      const difference = Math.abs(videoDuration - sourceDuration!);
      const tolerance = Math.max(2, videoDuration * 0.003);
      if (difference > tolerance) return -difference;
      return 500 - difference;
    }

    // A source without duration can be used as a fallback, but it must never
    // replace a candidate already proven to match the visible player's timebase.
    return 10;
  }

  private selectBestSource(): void {
    const candidates = Array.from(this.sourceCandidates.values());
    if (candidates.length === 0) return;
    candidates.sort((a, b) => this.sourceScore(b) - this.sourceScore(a));
    const best = candidates[0];
    const bestScore = this.sourceScore(best);
    const currentScore = this.activeSource ? this.sourceScore(this.activeSource) : Number.NEGATIVE_INFINITY;

    if (bestScore < 0) {
      // Nothing detected matches this video. Drop a choice made before the
      // video's length was known (e.g. a single 8 s stream segment) rather
      // than sending the wrong media to the server.
      if (this.activeSource && currentScore < 0) {
        this.activeSource = null;
        this.syncComponents();
      }
      return;
    }
    if (this.activeSource && currentScore > bestScore) return;
    this.activeSource = best;
    if (best.qualities && best.qualities.length > 0) {
      const stillAvailable = this.selectedQuality && best.qualities.some(
        (quality) => quality.variant_url === this.selectedQuality?.variant_url && quality.height === this.selectedQuality?.height
      );
      if (!stillAvailable) this.selectedQuality = best.qualities[0];
    }
    if (this.segments.length === 0) {
      void this.restoreDraftIfNeeded();
    }
    this.syncComponents();
  }

  private sourceMatchesPlayerTimeline(source: DetectedSource): boolean {
    const videoDuration = this.videoEl.duration;
    const sourceDuration = source.duration_seconds;
    if (!Number.isFinite(videoDuration) || videoDuration <= 0 || !Number.isFinite(sourceDuration) || sourceDuration! <= 0) {
      return true;
    }
    return Math.abs(videoDuration - sourceDuration!) <= Math.max(2, videoDuration * 0.003);
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

  // =========================================================== segments
  //
  // Every change to the segment list goes through commit(): the list is kept
  // in video order, the previous state can be pushed onto the undo history,
  // and the UI, side panel and auto-save are updated in one place.

  private commit(next: Segment[], undoLabel?: string, coalesceKey?: string): void {
    if (undoLabel) this.pushUndo(undoLabel, coalesceKey);
    if (!this.videoIdentity) this.videoIdentity = this.currentVideoIdentity();
    this.segments = sortSegments(next);
    if (this.editingSegmentId && !this.segments.some((s) => s.id === this.editingSegmentId)) {
      this.editingSegmentId = null;
      this.startMarker = null;
      this.endMarker = null;
    }
    this.syncComponents();
    chrome.runtime.sendMessage({
      type: 'OVERLAY_SEGMENTS_UPDATED',
      payload: { segments: this.segments, sourceId: this.activeSource?.id },
    }).catch(() => {});
    this.triggerAutoSave(true);
  }

  private pushUndo(label: string, coalesceKey?: string): void {
    const top = this.undoStack[this.undoStack.length - 1];
    // Rapid repeated nudges of the same edge count as one step.
    if (coalesceKey && top?.key === coalesceKey && Date.now() - top.at < 1500) {
      top.at = Date.now();
      return;
    }
    this.undoStack.push({ label, key: coalesceKey, at: Date.now(), segments: this.segments.map((s) => ({ ...s, categories: [...s.categories] })) });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  public undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) {
      this.toast('Nothing to undo');
      return;
    }
    this.commit(entry.segments);
    this.toast(`Undone: ${entry.label}`, 'ok');
  }

  private segmentNumber(id: string): number {
    return this.segments.findIndex((s) => s.id === id) + 1;
  }

  private toast(message: string, kind: 'info' | 'ok' | 'error' = 'info', withUndo = false): void {
    showOverlayToast(this.toastParent(), message, {
      kind,
      action: withUndo ? { label: 'Undo', icon: ICONS.undo, run: () => this.undo() } : undefined,
    });
  }

  private toastParent(): HTMLElement {
    return (document.fullscreenElement as HTMLElement) || this.playerParent;
  }

  private currentVideoIdentity(): string | null {
    const duration = this.videoEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const src = this.videoEl.currentSrc || this.videoEl.src || '';
    const address = src && !src.startsWith('blob:') ? normalizeUrl(src) : 'blob';
    return `${address}|${Math.round(duration * 10)}`;
  }

  /**
   * A different video was loaded into the same player (next episode, the
   * dashboard's previous/next, a site's autoplay). Segments belong to the
   * video they were tagged on, so they are set aside (they stay in that
   * video's auto-saved draft) and the new video's own draft is loaded.
   */
  private handleVideoLoaded(): void {
    const identity = this.currentVideoIdentity();
    if (identity && this.videoIdentity && identity !== this.videoIdentity) {
      if (this.autoSaveTimer) {
        clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = null;
      }
      const hadSegments = this.segments.length > 0;
      this.stopSegmentPlayback();
      this.segments = [];
      this.undoStack = [];
      this.editingSegmentId = null;
      this.startMarker = null;
      this.endMarker = null;
      this.hasRestoredDraft = false;
      this.activeSource = null;
      this.playerParent.querySelector('.vdt-restore-toast')?.remove();
      this.syncComponents();
      if (hadSegments) this.toast('New video loaded — the previous video’s segments are kept in its own draft');
    }
    if (identity) this.videoIdentity = identity;
    this.selectBestSource();
    if (this.segments.length === 0) void this.restoreDraftIfNeeded();
  }

  private get duration(): number | undefined {
    const value = this.videoEl.duration;
    return Number.isFinite(value) && value > 0 ? value : this.activeSource?.duration_seconds;
  }

  public setSegments(segments: Segment[]): void {
    this.segments = sortSegments(segments);
    this.syncComponents();
  }

  /** Select a segment for editing (or clear the selection with null). */
  public selectSegment(id: string | null, seekToStart = true): void {
    const seg = id ? this.segments.find((s) => s.id === id) : null;
    if (!seg) {
      this.stopEditing();
      return;
    }
    this.editingSegmentId = seg.id;
    this.startMarker = seg.start_seconds;
    this.endMarker = seg.end_seconds;
    this.selectedCategoryId = seg.categories[0] || this.selectedCategoryId;
    if (seekToStart) this.adapter.seek(seg.start_seconds);
    if (!this.drawer.visible) this.drawer.show();
    this.syncComponents();
  }

  /** Kept for callers that still use the old name. */
  public loadSegmentForEditing(segmentId: string): void {
    this.selectSegment(segmentId);
  }

  private stopEditing(): void {
    this.editingSegmentId = null;
    this.startMarker = null;
    this.endMarker = null;
    this.syncComponents();
    this.triggerAutoSave(false);
  }

  /** Validate and apply a new start or end for an existing segment. */
  public setSegmentTime(id: string, edge: SegmentEdge, seconds: number, coalesce = false): string | null {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return 'Segment not found';
    const value = clampTime(seconds, this.duration);
    const start = edge === 'start' ? value : seg.start_seconds;
    const end = edge === 'end' ? value : seg.end_seconds;
    const error = rangeError(start, end, this.duration);
    if (error) {
      this.toast(error, 'error');
      return error;
    }
    const number = this.segmentNumber(id);
    const next = this.segments.map((s) => (s.id === id ? { ...s, start_seconds: start, end_seconds: end } : s));
    if (this.editingSegmentId === id) {
      this.startMarker = start;
      this.endMarker = end;
    }
    this.drawer.setStatus(null);
    this.commit(next, `edit segment ${number}`, coalesce ? `${id}:${edge}` : undefined);
    return null;
  }

  public nudgeSegment(id: string, edge: SegmentEdge, delta: number): void {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return;
    const current = edge === 'start' ? seg.start_seconds : seg.end_seconds;
    const target = roundTime(current + delta);
    if (this.setSegmentTime(id, edge, target, true) === null) {
      // Show the frame the edge now sits on.
      this.adapter.seek(edge === 'end' ? Math.max(0, target - 0.001) : target);
    }
  }

  public setSegmentEdgeToPlayhead(id: string, edge: SegmentEdge): void {
    this.setSegmentTime(id, edge, this.videoEl.currentTime);
  }

  /** Play one segment and stop at its end. */
  public playSegment(id: string): void {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return;
    this.stopSegmentPlayback();
    this.adapter.seek(seg.start_seconds);
    this.adapter.play().catch(() => {});
    const { start_seconds: start, end_seconds: end } = seg;
    const watch = () => {
      const t = this.videoEl.currentTime;
      if (this.videoEl.paused || t < start - 0.5 || t > end + 0.5) {
        this.segmentPlayback = 0; // the user took over
        return;
      }
      if (t >= end - 0.02) {
        this.adapter.pause();
        this.segmentPlayback = 0;
        return;
      }
      this.segmentPlayback = requestAnimationFrame(watch);
    };
    // Give the seek a moment to land before watching the position.
    window.setTimeout(() => { this.segmentPlayback = requestAnimationFrame(watch); }, 150);
  }

  private stopSegmentPlayback(): void {
    if (this.segmentPlayback) cancelAnimationFrame(this.segmentPlayback);
    this.segmentPlayback = 0;
  }

  public markStart(time: number): void {
    const value = clampTime(time, this.duration);
    if (this.editingSegmentId) {
      // While a segment is selected, the markers edit it directly.
      this.setSegmentTime(this.editingSegmentId, 'start', value);
      return;
    }
    this.startMarker = value;
    this.timeline.setMarkers(this.startMarker, this.endMarker);
    this.bar.updateState({ startMarker: this.startMarker });
    this.triggerAutoSave(false);
  }

  public markEnd(time: number): void {
    const value = clampTime(time, this.duration);
    if (this.editingSegmentId) {
      this.setSegmentTime(this.editingSegmentId, 'end', value);
      return;
    }
    this.endMarker = value;
    this.timeline.setMarkers(this.startMarker, this.endMarker);
    this.bar.updateState({ endMarker: this.endMarker });
    this.triggerAutoSave(false);
  }

  public updateSegmentCategory(segmentId: string, newCategoryId: string): void {
    const seg = this.segments.find((s) => s.id === segmentId);
    if (!seg || seg.categories[0] === newCategoryId) return;
    const next = this.segments.map((s) => (s.id === segmentId ? { ...s, categories: [newCategoryId] } : s));
    this.commit(next, `relabel segment ${this.segmentNumber(segmentId)}`);
  }

  public resetMarkers(): void {
    if (this.editingSegmentId) {
      this.stopEditing();
      return;
    }
    this.startMarker = null;
    this.endMarker = null;
    this.timeline.setMarkers(null, null);
    this.bar.updateState({ startMarker: null, endMarker: null, editingSegmentId: null });
    this.triggerAutoSave(false);
  }

  /** Save the marked range as a new segment, or finish editing the selected one. */
  public saveSegment(): void {
    if (this.editingSegmentId) {
      this.stopEditing();
      return;
    }
    if (this.startMarker === null) {
      this.toast('Mark the start first: press [ or the start button', 'error');
      return;
    }
    let start = this.startMarker;
    let end = this.endMarker !== null ? this.endMarker : clampTime(this.videoEl.currentTime, this.duration);
    if (end < start) [start, end] = [end, start]; // marked out of order
    const error = rangeError(start, end, this.duration);
    if (error) {
      this.toast(error, 'error');
      return;
    }
    const segment: Segment = {
      id: generateId('seg'),
      start_seconds: start,
      end_seconds: end,
      categories: [this.selectedCategoryId],
    };
    this.startMarker = null;
    this.endMarker = null;
    this.commit([...this.segments, segment], 'add segment');
    this.toast(`Segment ${this.segmentNumber(segment.id)} saved · ${formatTime(start)} → ${formatTime(end)}`, 'ok');
  }

  public deleteSegment(id: string): void {
    const number = this.segmentNumber(id);
    if (!number) return;
    this.stopSegmentPlayback();
    this.commit(this.segments.filter((s) => s.id !== id), `delete segment ${number}`);
    this.toast(`Segment ${number} deleted`, 'info', true);
  }

  public clearAllSegments(): void {
    if (!this.segments.length) return;
    const count = this.segments.length;
    this.stopSegmentPlayback();
    this.editingSegmentId = null;
    this.startMarker = null;
    this.endMarker = null;
    this.commit([], `remove all ${count} segments`);
    this.playerParent.querySelector('.vdt-restore-toast')?.remove();
    this.toast(`${count} segment${count === 1 ? '' : 's'} removed`, 'info', true);
  }

  private syncComponents(): void {
    this.timeline.setSegments(this.segments);
    this.timeline.setCategories(this.categories);
    this.timeline.setSelected(this.editingSegmentId);
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

    this.drawer.updateData({
      segments: this.segments,
      categories: this.categories,
      selectedId: this.editingSegmentId,
      overlaps: findOverlaps(this.segments),
      undoLabel: this.undoStack[this.undoStack.length - 1]?.label || null,
    });
    this.drawer.setPlayhead(segmentAt(this.segments, this.videoEl.currentTime)?.id || null);
  }

  public async loadImportedSegments(importedSegments: any[]): Promise<boolean> {
    try {
      const mapped: Segment[] = importedSegments
        .map((s) => ({
          id: generateId('seg'),
          start_seconds: roundTime(Number(s.start_seconds)),
          end_seconds: roundTime(Number(s.end_seconds)),
          categories: s.categories || (s.category ? [s.category] : [this.selectedCategoryId]),
        }))
        .filter((s) => rangeError(s.start_seconds, s.end_seconds) === null);
      if (!mapped.length) return false;
      this.commit([...this.segments, ...mapped], `import ${mapped.length} segments`);
      this.toast(`${mapped.length} segments imported`, 'ok', true);
      return true;
    } catch (err: any) {
      console.error('Load imported segments error:', err);
      return false;
    }
  }

  public async submitJob(): Promise<void> {
    if (this.segments.length === 0) {
      this.toast('Save at least one segment first', 'error');
      return;
    }

    const videoLength = this.videoEl.duration;
    if (Number.isFinite(videoLength) && videoLength > 0) {
      const index = this.segments.findIndex((s) => s.end_seconds > videoLength + 0.05);
      if (index >= 0) {
        this.toast(
          `Segment ${index + 1} ends at ${formatTime(this.segments[index].end_seconds)}, but this video is only ${formatTime(videoLength)} long. Fix or delete it before sending.`,
          'error'
        );
        this.selectSegment(this.segments[index].id, false);
        return;
      }
    }

    if (this.activeSource && !this.sourceMatchesPlayerTimeline(this.activeSource)) {
      this.toast('The detected stream does not match this video’s length. Reload and wait for detection so times are not shifted.', 'error');
      return;
    }

    const mediaUrl = this.activeSource?.media_url || this.videoEl.currentSrc || this.videoEl.src;
    if (!mediaUrl) {
      this.toast('No video address detected yet', 'error');
      return;
    }
    if (mediaUrl.startsWith('blob:')) {
      this.toast('The stream has not been detected yet. Wait a moment or reload the video.', 'error');
      return;
    }

    this.isSubmitting = true;
    this.bar.updateState({ isSubmitting: true });
    this.drawer.setSubmitting(true, 'Sending to server…');

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
          this.drawer.setSubmitting(false, `Sent as ${res.job_id}`);
          this.toast(`Sent ${this.segments.length} segments to the server`, 'ok');
          void StorageService.clearDraftForVideo(
            window.location.href,
            this.activeSource?.media_url || this.videoEl.currentSrc
          );
          this.playerParent.querySelector('.vdt-restore-toast')?.remove();
        } else {
          const errText = res?.error || 'Could not connect to backend server';
          this.drawer.setSubmitting(false, errText, 'error');
          this.toast(`Could not send: ${errText}`, 'error');
        }
      }
    );
  }

  private async restoreDraftIfNeeded(): Promise<void> {
    if (this.hasRestoredDraft || this.segments.length > 0) return;
    // Without the video's length there is no safe way to tell which draft is its own.
    if (!Number.isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) return;
    try {
      const draft = await StorageService.findDraft(
        window.location.href,
        this.activeSource?.media_url || this.videoEl.currentSrc,
        this.videoEl.duration
      );
      if (draft && draft.segments && draft.segments.length > 0 && this.segments.length === 0) {
        this.videoIdentity = this.currentVideoIdentity();
        this.segments = sortSegments(draft.segments);
        if (draft.selectedCategoryId) {
          this.selectedCategoryId = draft.selectedCategoryId;
        }
        if (draft.startMarker != null) {
          this.startMarker = draft.startMarker;
        }
        if (draft.endMarker != null) {
          this.endMarker = draft.endMarker;
        }
        this.hasRestoredDraft = true;
        this.syncComponents();
        this.showRestoreToast(this.segments.length, draft.updated_at);
      }
    } catch (err) {
      console.warn('[PlayerIntegrated] Draft restore error:', err);
    }
  }

  private showRestoreToast(count: number, timestamp: number): void {
    const existing = this.playerParent.querySelector('.vdt-restore-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'vdt-restore-toast';
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: #38bdf8; display: inline-flex;">${ICONS.restore}</span>
        <div style="color: #cbd5e1; font-size: 11px;">Restored <strong style="color: #f8fafc;">${count}</strong> saved segment${count === 1 ? '' : 's'} · ${timeStr}</div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px; margin-left: 12px;">
        <button id="vdt-toast-dismiss" class="vdt-btn vdt-btn-icon" title="Keep restored segments" aria-label="Keep restored segments">${ICONS.check}</button>
        <button id="vdt-toast-clear" class="vdt-btn vdt-btn-icon vdt-btn-danger" title="Discard restored segments" aria-label="Discard restored segments">${ICONS.trash}</button>
      </div>
    `;

    toast.querySelector('#vdt-toast-dismiss')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });

    toast.querySelector('#vdt-toast-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.remove();
      this.clearAllSegments(); // offers Undo
    });

    this.playerParent.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
      }
    }, 7000);
  }

  private triggerAutoSave(immediate: boolean = false): void {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    const performSave = async () => {
      if (this.segments.length === 0 && this.startMarker == null && this.endMarker == null) {
        await StorageService.clearDraftForVideo(
          window.location.href,
          this.activeSource?.media_url || this.videoEl.currentSrc
        );
        return;
      }

      await StorageService.saveDraft({
        page_url: window.location.href,
        referrer: document.referrer,
        media_url: this.activeSource?.media_url || this.videoEl.currentSrc,
        duration: this.videoEl.duration || this.activeSource?.duration_seconds,
        segments: this.segments,
        selectedCategoryId: this.selectedCategoryId,
        startMarker: this.startMarker,
        endMarker: this.endMarker,
      });
    };

    if (immediate) {
      void performSave();
    } else {
      this.autoSaveTimer = setTimeout(performSave, 400);
    }
  }

  private flushAutoSaveSync(): void {
    if (this.segments.length > 0 || this.startMarker != null || this.endMarker != null) {
      StorageService.saveDraftSync({
        page_url: window.location.href,
        referrer: document.referrer,
        media_url: this.activeSource?.media_url || this.videoEl.currentSrc,
        duration: this.videoEl.duration || this.activeSource?.duration_seconds,
        segments: this.segments,
        selectedCategoryId: this.selectedCategoryId,
        startMarker: this.startMarker,
        endMarker: this.endMarker,
      });
    }
  }

  public destroy(): void {
    this.stopSegmentPlayback();
    this.barObserver?.disconnect();
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    window.removeEventListener('pagehide', this.handlePageHide);
    this.videoEl.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.timeline.destroy();
    this.bar.destroy();
    this.drawer.destroy();
  }
}
