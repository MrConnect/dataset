import { Category, ExtensionSettings, TaggingSession } from '../types';

const DEFAULT_CATEGORIES: Category[] = [];

const DEFAULT_SETTINGS: ExtensionSettings = {
  api_base_url: 'https://dataset.mem-dev.uk',
  api_key: 'test_dev_key',
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
    const local = localStorage.getItem('tagger_settings');
    return local ? { ...DEFAULT_SETTINGS, ...JSON.parse(local) } : DEFAULT_SETTINGS;
  },

  async saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...settings };
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ tagger_settings: updated });
    } else {
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
    const local = localStorage.getItem('tagger_categories');
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
    } else {
      localStorage.setItem('tagger_categories', JSON.stringify(categories));
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
};
