import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService, normalizeUrl, computeSmartDraftId } from '../services/storage';

// Simple in-memory mock for localStorage in Node test environment
const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, value: string) => { mockStorage[key] = value; },
  removeItem: (key: string) => { delete mockStorage[key]; },
  clear: () => {
    for (const k of Object.keys(mockStorage)) {
      delete mockStorage[k];
    }
  },
};
(globalThis as any).localStorage = mockLocalStorage;

describe('Smart Auto-Save & Recovery', () => {
  beforeEach(() => {
    (globalThis as any).localStorage.clear();
  });

  it('normalizes URLs by removing volatile tracking params and hashes', () => {
    const url1 = 'https://vidfast.vc/movie/tt123456?utm_source=fb&token=xyz#player';
    const url2 = 'https://vidfast.vc/movie/tt123456?cb=998';
    expect(normalizeUrl(url1)).toBe('https://vidfast.vc/movie/tt123456');
    expect(normalizeUrl(url2)).toBe('https://vidfast.vc/movie/tt123456');
    expect(computeSmartDraftId(url1)).toBe(computeSmartDraftId(url2));
  });

  it('correctly assesses duration compatibility', () => {
    expect(StorageService.isDurationCompatible(1800, 1802)).toBe(true);
    expect(StorageService.isDurationCompatible(1800, 1820)).toBe(true); // 3% of 1800 is 54s
    expect(StorageService.isDurationCompatible(1800, 2400)).toBe(false); // different video
    expect(StorageService.isDurationCompatible(undefined, 1800)).toBe(true); // fallback when unknown
  });

  it('saves, finds and clears drafts via localStorage fallback', async () => {
    const pageUrl = 'https://vidfast.vc/movie/tt37287335';
    const mediaUrl = 'https://stream.server.com/video/master.m3u8';

    await StorageService.saveDraft({
      page_url: pageUrl,
      media_url: mediaUrl,
      duration: 3600,
      segments: [
        { id: 'seg_1', start_seconds: 10, end_seconds: 25, categories: ['walking'] },
      ],
      selectedCategoryId: 'walking',
      startMarker: null,
      endMarker: null,
    });

    // Try finding it with same page URL but stripped query
    const found = await StorageService.findDraft(
      'https://vidfast.vc/movie/tt37287335?utm_source=twitter',
      mediaUrl,
      3602
    );

    expect(found).not.toBeNull();
    expect(found?.segments.length).toBe(1);
    expect(found?.segments[0].id).toBe('seg_1');

    // Clear draft
    await StorageService.clearDraftForVideo(pageUrl, mediaUrl);
    const afterClear = await StorageService.findDraft(pageUrl, mediaUrl, 3600);
    expect(afterClear).toBeNull();
  });
});
