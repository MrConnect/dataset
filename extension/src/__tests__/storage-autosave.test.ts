import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService, normalizeUrl, computeSmartDraftId, isSameVideo } from '../services/storage';

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

describe('Drafts never jump to another video', () => {
  const page = 'https://dataset.example.com/dashboard/index.html#library';
  const movie = 'https://dataset.example.com/api/v1/dataset/file/_downloads/movie.mp4';
  const clip = 'https://dataset.example.com/api/v1/dataset/file/walking/clip.mp4';
  const segments = [{ id: 'seg_1', start_seconds: 5, end_seconds: 11.042, categories: ['walking'] }];

  beforeEach(() => {
    (globalThis as any).localStorage.clear();
  });

  it('does not restore a draft before the video length is known', async () => {
    await StorageService.saveDraft({ page_url: page, media_url: movie, duration: 60, segments });
    expect(await StorageService.findDraft(page, movie, NaN)).toBeNull();
    expect(await StorageService.findDraft(page, movie, undefined)).toBeNull();
    expect(await StorageService.findDraft(page, movie, 60)).not.toBeNull();
  });

  it('does not give one video\'s draft to another video on the same page', async () => {
    await StorageService.saveDraft({ page_url: page, media_url: movie, duration: 60, segments });
    // The dashboard: same page, a different (8 s) clip.
    expect(await StorageService.findDraft(page, clip, 8.008)).toBeNull();
    // Same page, different file of the same length: still a different video.
    expect(await StorageService.findDraft(page, clip, 60)).toBeNull();
  });

  it('rejects drafts whose segments do not fit the video', () => {
    const draft = { page_url: page, media_url: undefined, duration: 8.2, segments };
    expect(isSameVideo(draft, page, '', 'blob:x', 8.2)).toBe(false);
  });

  it('still matches blob players by page and length', () => {
    const draft = { page_url: page, media_url: 'blob:https://site/1', duration: 1800, segments };
    expect(isSameVideo(draft, page, '', 'blob:https://site/2', 1801)).toBe(true);
    expect(isSameVideo(draft, page, '', 'blob:https://site/2', 1850)).toBe(false);
  });
});
