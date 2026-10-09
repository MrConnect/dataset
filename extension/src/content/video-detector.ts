import { PlayerIntegratedController } from './player-integrated';
import { StorageService } from '../services/storage';
import { DetectedSource, Category } from '../types';

/**
 * Network-First Video Detector
 * 
 * Architectural Fixes:
 * 1. Removed script unpacking and DOM MutationObserver polling.
 * 2. Entirely driven by NETWORK_SOURCE_DETECTED messages from background script.
 * 3. Only hooks into <video> elements when a stream is actively confirmed on the network for this frame.
 */
class VideoDetector {
  private controllers: Map<number, PlayerIntegratedController> = new Map();
  private detectedSources: Map<string, DetectedSource> = new Map();
  private categories: Category[] = [];

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    this.categories = await StorageService.getCategories();
    this.setupMessageListener();
    this.setupSpaListener();
    console.log('[VideoDetector] Network-first detection initialized in frame.');
  }

  private isHtmlPageUrl(url: string): boolean {
    if (!url) return true;
    try {
      const u = new URL(url);
      if (!u.pathname || u.pathname === '/') return true;
      if (u.pathname.endsWith('.html') || u.pathname.endsWith('.php')) return true;
    } catch {
      return true;
    }
    return false;
  }

  /**
   * Scans document for HTML5 video elements ONCE a stream is detected.
   */
  private scanDomVideosForStream(source: DetectedSource): void {
    const videoElements = Array.from(document.querySelectorAll('video'));
    
    if (videoElements.length === 0) {
      // If no video is found yet (e.g. still rendering), wait a bit and retry once
      setTimeout(() => {
        const retryElements = Array.from(document.querySelectorAll('video'));
        retryElements.forEach((videoEl, index) => {
          this.attachController(videoEl, index, source);
        });
      }, 1000);
      return;
    }

    videoElements.forEach((videoEl, index) => {
      this.attachController(videoEl, index, source);
    });
  }

  private attachController(videoEl: HTMLVideoElement, index: number, source: DetectedSource): void {
    if (!this.controllers.has(index)) {
      console.log('[VideoDetector] Attaching controller to video element', videoEl);
      const controller = new PlayerIntegratedController(videoEl, index);
      controller.setCategories(this.categories);
      this.controllers.set(index, controller);
    }
    
    // Always update source
    const ctrl = this.controllers.get(index);
    if (ctrl) {
      ctrl.setSource(source);
    }
  }

  private setupSpaListener(): void {
    const handleUrlChange = () => {
      this.controllers.forEach((c) => c.destroy());
      this.controllers.clear();
      this.detectedSources.clear();
    };

    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const res = originalPushState.apply(this, args);
      handleUrlChange();
      return res;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const res = originalReplaceState.apply(this, args);
      handleUrlChange();
      return res;
    };
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || !message.type) return;

      switch (message.type) {
        case 'NETWORK_SOURCE_DETECTED': {
          const { source } = message.payload;
          if (source && !this.isHtmlPageUrl(source.media_url)) {
            console.log('[VideoDetector] Received network source:', source.media_url);
            this.detectedSources.set(source.id, source);
            this.scanDomVideosForStream(source);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'SOURCE_RESOLVED': {
          const { source } = message.payload;
          if (source && !this.isHtmlPageUrl(source.media_url)) {
            this.detectedSources.set(source.id, source);
            this.scanDomVideosForStream(source);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'IMPORT_JOB_JSON': {
          const { segments } = message.payload;
          if (this.controllers.size > 0) {
            // Grab the first controller (usually there is only 1 video)
            const firstController = Array.from(this.controllers.values())[0];
            firstController.submitImportedSegments(segments).then(success => {
              sendResponse({ ok: success });
            });
          } else {
            sendResponse({ ok: false });
          }
          return true; // Keep channel open for async response
        }

        case 'GET_ACTIVE_TAB_DATA': {
          const sources = Array.from(this.detectedSources.values()).filter(
            (s) => !this.isHtmlPageUrl(s.media_url)
          );
          sendResponse({
            ok: true,
            sources,
          });
          break;
        }

        default:
          break;
      }
      return true;
    });
  }
}

new VideoDetector();
