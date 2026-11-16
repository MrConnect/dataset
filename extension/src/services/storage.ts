import { Category, ExtensionSettings, TaggingSession, AutoSaveDraft, Segment } from '../types';

const DEFAULT_CATEGORIES: Category[] = [];

const DEFAULT_SETTINGS: ExtensionSettings = {
  api_base_url: 'https://dataset.mem-dev.uk',
  api_key: '',
  default_quality_height: 720,
  default_category_id: 'person_walking',
  auto_detection_enabled: true,
  show_floating_overlay: true,
  shortcuts: {
    mark_start: '[',
    mark_end: ']',
    save_segment: 'Control+Enter',
    cancel_selection: 'Escape',
  },
};

const DB_NAME = 'VideoDatasetTaggerDB';
const DB_VERSION = 1;
const STORE_SESSIONS = 'tagging_sessions';
const CATEGORY_SYNC_MARKER = 'tagger_categories_server_sync_v1';
const DRAFT_INDEX_KEY = 'vdt_drafts_index_v1';
const DRAFT_PREFIX = 'vdt_draft_';
const MAX_SAVED_DRAFTS = 40;
const DRAFT_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    const searchParams = new URLSearchParams(u.search);
    const volatileParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'token', 'expires', 'auth', 't', '_t', 'ts', 'cb', 'nonce', 'signature', 'sig'
    ];
    volatileParams.forEach((p) => searchParams.delete(p));
    const cleanSearch = searchParams.toString();
    return `${u.origin}${u.pathname}${cleanSearch ? '?' + cleanSearch : ''}`.toLowerCase();
  } catch {
    return rawUrl.toLowerCase().split('#')[0];
  }
}

function hashString(str: string): string {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c64e6d ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function computeSmartDraftId(pageUrl: string, mediaUrl?: string): string {
  const normPage = normalizeUrl(pageUrl);
  let normMedia = '';
  if (mediaUrl && !mediaUrl.startsWith('blob:')) {
    try {
      const u = new URL(mediaUrl);
      normMedia = u.pathname;
    } catch {
      normMedia = mediaUrl;
    }
  }
  const combined = normMedia ? `${normPage}::${normMedia}` : normPage;
  return `d_${hashString(combined)}`;
}

/**
 * Open or upgrade IndexedDB
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        store.createIndex('page_url', 'page_url', { unique: false });
        store.createIndex('video_id', 'video_id', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const StorageService = {
  // Settings
  async getSettings(): Promise<ExtensionSettings> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const res = await chrome.storage.local.get('tagger_settings');
      return { ...DEFAULT_SETTINGS, ...(res.tagger_settings || {}) };
    }
    const local = typeof localStorage !== 'undefined' ? localStorage.getItem('tagger_settings') : null;
    return local ? { ...DEFAULT_SETTINGS, ...JSON.parse(local) } : DEFAULT_SETTINGS;
  },

  async saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...settings };
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ tagger_settings: updated });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('tagger_settings', JSON.stringify(updated));
    }
    return updated;
  },

  // Categories
  async getCategories(): Promise<Category[]> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const res = await chrome.storage.local.get('tagger_categories');
      if (res.tagger_categories && Array.isArray(res.tagger_categories)) {
        return res.tagger_categories;
      }
      await this.saveCategories(DEFAULT_CATEGORIES);
      return DEFAULT_CATEGORIES;
    }
    const local = typeof localStorage !== 'undefined' ? localStorage.getItem('tagger_categories') : null;
    if (local) {
      try {
        return JSON.parse(local);
      } catch {
        // fallback
      }
    }
    return DEFAULT_CATEGORIES;
  },

  async saveCategories(categories: Category[]): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ tagger_categories: categories });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('tagger_categories', JSON.stringify(categories));
    }
  },

  async isCategorySyncInitialized(): Promise<boolean> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const res = await chrome.storage.local.get(CATEGORY_SYNC_MARKER);
      return res[CATEGORY_SYNC_MARKER] === true;
    }
    return typeof localStorage !== 'undefined' ? localStorage.getItem(CATEGORY_SYNC_MARKER) === 'true' : false;
  },

  async markCategorySyncInitialized(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ [CATEGORY_SYNC_MARKER]: true });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CATEGORY_SYNC_MARKER, 'true');
    }
  },

  // Sessions (IndexedDB)
  async saveSession(session: TaggingSession): Promise<void> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.put(session);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async getSession(sessionId: string): Promise<TaggingSession | null> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.get(sessionId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async getSessionByPageAndVideo(pageUrl: string, videoId: string): Promise<TaggingSession | null> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          if (cursor.value.page_url === pageUrl && cursor.value.video_id === videoId) {
            resolve(cursor.value);
            return;
          }
          cursor.continue();
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  // --- Smart Auto-Save & Recovery ---

  async saveDraft(params: {
    page_url: string;
    referrer?: string;
    media_url?: string;
    duration?: number;
    segments: Segment[];
    selectedCategoryId?: string;
    startMarker?: number | null;
    endMarker?: number | null;
  }): Promise<string> {
    const id = computeSmartDraftId(params.page_url, params.media_url);
    const draft: AutoSaveDraft = {
      id,
      page_url: params.page_url,
      referrer: params.referrer,
      media_url: params.media_url,
      duration: params.duration,
      segments: params.segments,
      selectedCategoryId: params.selectedCategoryId,
      startMarker: params.startMarker,
      endMarker: params.endMarker,
      updated_at: Date.now(),
    };

    // 1. Synchronous localStorage fallback
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`${DRAFT_PREFIX}${id}`, JSON.stringify(draft));
      } catch {}
    }

    // 2. Primary chrome.storage.local
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const fullKey = `${DRAFT_PREFIX}${id}`;
        await chrome.storage.local.set({ [fullKey]: draft });

        // Update index list
        const res = await chrome.storage.local.get(DRAFT_INDEX_KEY);
        let index: string[] = Array.isArray(res[DRAFT_INDEX_KEY]) ? res[DRAFT_INDEX_KEY] : [];
        index = [id, ...index.filter((k) => k !== id)];

        // Prune old drafts
        if (index.length > MAX_SAVED_DRAFTS) {
          const toRemove = index.slice(MAX_SAVED_DRAFTS);
          index = index.slice(0, MAX_SAVED_DRAFTS);
          const removeKeys = toRemove.map((rid) => `${DRAFT_PREFIX}${rid}`);
          await chrome.storage.local.remove(removeKeys);
        }
        await chrome.storage.local.set({ [DRAFT_INDEX_KEY]: index });
      } catch (err) {
        console.warn('[StorageService] Auto-save to chrome.storage failed:', err);
      }
    }

    return id;
  },

  saveDraftSync(params: {
    page_url: string;
    referrer?: string;
    media_url?: string;
    duration?: number;
    segments: Segment[];
    selectedCategoryId?: string;
    startMarker?: number | null;
    endMarker?: number | null;
  }): void {
    if (typeof localStorage !== 'undefined') {
      try {
        const id = computeSmartDraftId(params.page_url, params.media_url);
        const draft: AutoSaveDraft = {
          id,
          page_url: params.page_url,
          referrer: params.referrer,
          media_url: params.media_url,
          duration: params.duration,
          segments: params.segments,
          selectedCategoryId: params.selectedCategoryId,
          startMarker: params.startMarker,
          endMarker: params.endMarker,
          updated_at: Date.now(),
        };
        localStorage.setItem(`${DRAFT_PREFIX}${id}`, JSON.stringify(draft));
      } catch {}
    }
  },

  async findDraft(
    pageUrl: string,
    mediaUrl?: string,
    duration?: number
  ): Promise<AutoSaveDraft | null> {
    const candidateIds = new Set<string>();

    candidateIds.add(computeSmartDraftId(pageUrl, mediaUrl));
    candidateIds.add(computeSmartDraftId(pageUrl));

    if (typeof document !== 'undefined' && document.referrer) {
      candidateIds.add(computeSmartDraftId(document.referrer, mediaUrl));
      candidateIds.add(computeSmartDraftId(document.referrer));
    }

    // 1. Try chrome.storage.local first
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const keysToFetch = Array.from(candidateIds).map((id) => `${DRAFT_PREFIX}${id}`);
        const res = await chrome.storage.local.get(keysToFetch);
        for (const fullKey of keysToFetch) {
          const draft = res[fullKey] as AutoSaveDraft | undefined;
          if (draft && draft.segments && draft.segments.length > 0) {
            if (this.isDurationCompatible(draft.duration, duration)) {
              return draft;
            }
          }
        }

        // If direct match failed, scan through recent drafts in index
        const indexRes = await chrome.storage.local.get(DRAFT_INDEX_KEY);
        const index: string[] = Array.isArray(indexRes[DRAFT_INDEX_KEY]) ? indexRes[DRAFT_INDEX_KEY] : [];
        if (index.length > 0) {
          const allDraftKeys = index.map((id) => `${DRAFT_PREFIX}${id}`);
          const allRes = await chrome.storage.local.get(allDraftKeys);
          const normCurrentPage = normalizeUrl(pageUrl);
          const normReferrer = typeof document !== 'undefined' && document.referrer ? normalizeUrl(document.referrer) : '';

          for (const key of allDraftKeys) {
            const draft = allRes[key] as AutoSaveDraft | undefined;
            if (!draft || !draft.segments || draft.segments.length === 0) continue;

            if (Date.now() - draft.updated_at > DRAFT_EXPIRY_MS) continue;

            const normDraftPage = normalizeUrl(draft.page_url);
            const isPageMatch = normDraftPage === normCurrentPage || (normReferrer && normDraftPage === normReferrer);
            const isMediaMatch = mediaUrl && draft.media_url && !mediaUrl.startsWith('blob:') && draft.media_url === mediaUrl;

            if ((isPageMatch || isMediaMatch) && this.isDurationCompatible(draft.duration, duration)) {
              return draft;
            }
          }
        }
      } catch (err) {
        console.warn('[StorageService] Error querying chrome.storage drafts:', err);
      }
    }

    // 2. Fallback to localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        for (const id of candidateIds) {
          const item = localStorage.getItem(`${DRAFT_PREFIX}${id}`);
          if (item) {
            const draft = JSON.parse(item) as AutoSaveDraft;
            if (draft && draft.segments && draft.segments.length > 0) {
              if (this.isDurationCompatible(draft.duration, duration)) {
                return draft;
              }
            }
          }
        }
      } catch {}
    }

    return null;
  },

  isDurationCompatible(draftDuration?: number, currentDuration?: number): boolean {
    if (!draftDuration || !currentDuration || draftDuration <= 0 || currentDuration <= 0) {
      return true;
    }
    const tolerance = Math.max(3, currentDuration * 0.03);
    return Math.abs(draftDuration - currentDuration) <= tolerance;
  },

  async clearDraft(draftId: string): Promise<void> {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`${DRAFT_PREFIX}${draftId}`);
      } catch {}
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.remove(`${DRAFT_PREFIX}${draftId}`);
        const res = await chrome.storage.local.get(DRAFT_INDEX_KEY);
        let index: string[] = Array.isArray(res[DRAFT_INDEX_KEY]) ? res[DRAFT_INDEX_KEY] : [];
        index = index.filter((k) => k !== draftId);
        await chrome.storage.local.set({ [DRAFT_INDEX_KEY]: index });
      } catch {}
    }
  },

  async clearDraftForVideo(pageUrl: string, mediaUrl?: string): Promise<void> {
    const ids = [
      computeSmartDraftId(pageUrl, mediaUrl),
      computeSmartDraftId(pageUrl),
    ];
    if (typeof document !== 'undefined' && document.referrer) {
      ids.push(computeSmartDraftId(document.referrer, mediaUrl));
      ids.push(computeSmartDraftId(document.referrer));
    }
    for (const id of ids) {
      await this.clearDraft(id);
    }
  },
};
