import { VideoSourceResolver } from '../services/source-resolver';
import { DetectedSource } from '../types';

export class NetworkMonitor {
  private static seenUrls = new Set<string>();
  private static tabSources = new Map<number, Map<string, DetectedSource>>();
  private static requestHeaders = new Map<string, Record<string, string>>();

  static initialize(): void {
    if (typeof chrome === 'undefined' || !chrome.webRequest) {
      console.warn('[NetworkMonitor] chrome.webRequest is not available');
      return;
    }

    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const captured: Record<string, string> = {};
        for (const header of details.requestHeaders || []) {
          const name = header.name.toLowerCase();
          if (name === 'referer' || name === 'origin' || name === 'user-agent') {
            if (header.value) captured[header.name] = header.value;
          }
        }
        if (Object.keys(captured).length > 0) this.requestHeaders.set(details.requestId, captured);
      },
      { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
      ['requestHeaders', 'extraHeaders']
    );

    // Classify the response after we know its final Content-Type.
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (details.tabId < 0) return;

        const url = details.url;
        const capturedHeaders = this.requestHeaders.get(details.requestId) || {};
        this.requestHeaders.delete(details.requestId);
        // Ignore chunk fragments
        if (
          url.includes('.ts?') ||
          url.endsWith('.ts') ||
          url.includes('.m4s?') ||
          url.endsWith('.m4s') ||
          url.includes('.vtt') ||
          url.includes('.srt')
        ) {
          return;
        }

        let contentType = '';
        if (details.responseHeaders) {
          const ctHeader = details.responseHeaders.find(
            (h) => h.name.toLowerCase() === 'content-type'
          );
          if (ctHeader && ctHeader.value) {
            contentType = ctHeader.value.toLowerCase();
          }
        }

        const type = VideoSourceResolver.identifyType(url, contentType);
        if (type) {
          const dedupKey = `${details.tabId}_${details.frameId}_${VideoSourceResolver.getDeduplicationKey(url)}`;
          if (!this.seenUrls.has(dedupKey)) {
            this.seenUrls.add(dedupKey);
            this.handleDetectedSource(details.tabId, details.frameId, url, type, contentType, details.initiator, capturedHeaders);
          }
        }
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );

    chrome.webRequest.onErrorOccurred.addListener(
      (details) => this.requestHeaders.delete(details.requestId),
      { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
    );

    // Clean cache when tabs are closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.tabSources.delete(tabId);
      for (const key of Array.from(this.seenUrls)) {
        if (key.startsWith(`${tabId}_`)) {
          this.seenUrls.delete(key);
        }
      }
    });
  }

  private static async handleDetectedSource(
    tabId: number,
    frameId: number,
    url: string,
    type: string,
    contentType?: string,
    initiator?: string,
    capturedHeaders: Record<string, string> = {}
  ): Promise<void> {
    try {
      // 1. Get tab info to know page URL
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      // Prioritize initiator over tab URL to ensure correct Referer for iframes (fixes VidTube 403)
      const refererEntry = Object.entries(capturedHeaders).find(([name]) => name.toLowerCase() === 'referer');
      const pageUrl = refererEntry?.[1] || initiator || tab?.url || '';

      const headers: Record<string, string> = { ...capturedHeaders };
      if (pageUrl && !refererEntry) {
        headers['Referer'] = pageUrl;
      }

      // 2. Resolve source
      const resolved = await VideoSourceResolver.resolveSource(url, pageUrl, {
        contentType,
        title: tab?.title || `Stream (${type.toUpperCase()})`,
        headers,
      });

      // 3. Save to in-memory map
      if (!this.tabSources.has(tabId)) {
        this.tabSources.set(tabId, new Map());
      }
      this.tabSources.get(tabId)!.set(resolved.id, resolved);

      // 4. Save to session storage
      const storageKey = `tab_${tabId}_sources`;
      const current = await chrome.storage.session.get(storageKey).catch(() => ({ [storageKey]: [] }));
      const list: DetectedSource[] = current[storageKey] || [];
      if (!list.some((s) => s.media_url === resolved.media_url)) {
        list.push(resolved);
        await chrome.storage.session.set({ [storageKey]: list }).catch(() => {});
      }

      // 5. Broadcast to Side Panel & Content Script
      chrome.runtime.sendMessage({
        type: 'SOURCE_RESOLVED',
        payload: { source: resolved, tabId },
      }).catch(() => {});

      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'NETWORK_SOURCE_DETECTED',
          payload: { source: resolved, url, type, contentType },
        },
        { frameId: frameId },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch (err) {
      console.warn('[NetworkMonitor] Error processing detected source:', err);
    }
  }

  public static async getSourcesForTab(tabId: number): Promise<DetectedSource[]> {
    const memSources = this.tabSources.get(tabId);
    if (memSources && memSources.size > 0) {
      return Array.from(memSources.values());
    }

    // Fallback to session storage
    const storageKey = `tab_${tabId}_sources`;
    const res = await chrome.storage.session.get(storageKey).catch(() => ({ [storageKey]: [] }));
    return res[storageKey] || [];
  }

  public static registerTabSource(tabId: number, source: DetectedSource): void {
    if (!this.tabSources.has(tabId)) {
      this.tabSources.set(tabId, new Map());
    }
    this.tabSources.get(tabId)!.set(source.id, source);

    // Save to session storage
    const storageKey = `tab_${tabId}_sources`;
    chrome.storage.session.get(storageKey).then((current) => {
      const list: DetectedSource[] = current[storageKey] || [];
      if (!list.some((s) => s.id === source.id || s.media_url === source.media_url)) {
        list.push(source);
        chrome.storage.session.set({ [storageKey]: list }).catch(() => {});
      }
    }).catch(() => {});
  }
}
