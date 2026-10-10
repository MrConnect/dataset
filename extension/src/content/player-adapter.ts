export interface PlayerInfo {
  index: number;
  src: string;
  currentSrc: string;
  duration: number;
  currentTime: number;
  paused: boolean;
  videoWidth: number;
  videoHeight: number;
  element: HTMLVideoElement;
}

export class PlayerAdapter {
  private initialElement: HTMLVideoElement;
  private index: number;
  private onTimeUpdateCallback?: (time: number, duration: number) => void;
  private onPlayStateChangeCallback?: (paused: boolean) => void;
  
  private lastTime: number = 0;

  constructor(element: HTMLVideoElement, index: number) {
    this.initialElement = element;
    this.index = index;
    this.startPolling();
  }

  private get element(): HTMLVideoElement {
    // Dynamically find the actual video element in case the site replaces it
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return this.initialElement;
    
    // Prefer the playing video, or the one with a valid src, or fallback to the first/initial
    const playing = videos.find(v => !v.paused && v.readyState > 0);
    if (playing) return playing;
    
    const valid = videos.find(v => v.src || v.currentSrc);
    return valid || videos[0] || this.initialElement;
  }

  private startPolling(): void {
    // Instead of relying on native events which break if the video element is replaced,
    // poll the active video element state.
    window.setInterval(() => {
      const el = this.element;
      
      // Check time update
      if (this.onTimeUpdateCallback) {
        if (el.currentTime !== this.lastTime) {
          this.lastTime = el.currentTime;
          this.onTimeUpdateCallback(el.currentTime, el.duration || 0);
        }
      }
      
      // We don't easily poll play state changes without keeping track, so let's track it
      if (this.onPlayStateChangeCallback) {
        const isPaused = el.paused;
        if (this.lastPaused !== isPaused) {
          this.lastPaused = isPaused;
          this.onPlayStateChangeCallback(isPaused);
        }
      }
    }, 250);
  }
  
  private lastPaused: boolean = true;

  public onTimeUpdate(cb: (time: number, duration: number) => void): void {
    this.onTimeUpdateCallback = cb;
  }

  public onPlayStateChange(cb: (paused: boolean) => void): void {
    this.onPlayStateChangeCallback = cb;
  }

  public getInfo(): PlayerInfo {
    return {
      index: this.index,
      src: this.element.src,
      currentSrc: this.element.currentSrc,
      duration: isNaN(this.element.duration) ? 0 : this.element.duration,
      currentTime: isNaN(this.element.currentTime) ? 0 : this.element.currentTime,
      paused: this.element.paused,
      videoWidth: this.element.videoWidth,
      videoHeight: this.element.videoHeight,
      element: this.element,
    };
  }

  public seek(seconds: number): void {
    if (!isNaN(seconds) && isFinite(seconds)) {
      this.element.currentTime = Math.max(0, Math.min(seconds, this.element.duration || seconds));
    }
  }

  public play(): Promise<void> {
    return this.element.play();
  }

  public pause(): void {
    this.element.pause();
  }

  public togglePlay(): void {
    if (this.element.paused) {
      this.element.play().catch(() => {});
    } else {
      this.element.pause();
    }
  }
}
