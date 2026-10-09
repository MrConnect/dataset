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
  private element: HTMLVideoElement;
  private index: number;
  private onTimeUpdateCallback?: (time: number, duration: number) => void;

  constructor(element: HTMLVideoElement, index: number) {
    this.element = element;
    this.index = index;
    this.setupListeners();
  }

  private setupListeners(): void {
    this.element.addEventListener('timeupdate', () => {
      if (this.onTimeUpdateCallback) {
        this.onTimeUpdateCallback(this.element.currentTime, this.element.duration || 0);
      }
    });
  }

  public onTimeUpdate(cb: (time: number, duration: number) => void): void {
    this.onTimeUpdateCallback = cb;
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
