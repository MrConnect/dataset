import { DetectedSource, SourceType, VideoQuality } from '../types';
import { generateId } from '../utils/uuid';
import { ApiClient } from './api-client';

/** Last path component's extension, lower-case ('' when there is none). */
function pathExtension(cleanUrl: string): string {
  const name = cleanUrl.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

// Files a playlist is never named like. Streams often disguise their segments
// as images (".../hls/720/s_0.jpg"); those are pieces of a stream, not a stream.
const NOT_A_PLAYLIST = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'ico', 'svg', 'bmp',
  'ts', 'm4s', 'aac', 'mp3', 'm4a', 'vtt', 'srt', 'key', 'bin', 'dat',
  'js', 'mjs', 'css', 'html', 'htm', 'json', 'xml', 'woff', 'woff2', 'ttf', 'map',
]);

export class VideoSourceResolver {
  /** True for requests that are segments/assets of a stream rather than a playable source. */
  static isStreamFragment(url: string, contentType?: string): boolean {
    const cleanUrl = url.toLowerCase().split('?')[0];
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('mpegurl') || ct.includes('dash+xml')) return false;
    if (ct.startsWith('video/mp2t') || ct.startsWith('audio/') || ct.startsWith('image/')) return true;
    return NOT_A_PLAYLIST.has(pathExtension(cleanUrl));
  }

  static identifyType(url: string, contentType?: string): SourceType | null {
    const cleanUrl = url.toLowerCase().split('?')[0];
    if (this.isStreamFragment(url, contentType)) return null;

    if (contentType) {
      const ct = contentType.toLowerCase();
      if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) {
        return 'hls';
      }
      if (ct.includes('application/dash+xml')) {
        return 'dash';
      }
      if (ct.includes('video/mp4')) {
        return 'mp4';
      }
    }

    if (
      cleanUrl.endsWith('.m3u8') ||
      url.includes('.m3u8?') ||
      url.includes('/hls/') ||
      /\/(master|playlist|manifest)(?:[/.?]|$)/i.test(url)
    ) {
      return 'hls';
    }
    if (cleanUrl.endsWith('.mpd') || url.includes('.mpd?') || url.includes('/dash/')) {
      return 'dash';
    }
    if (cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.m4v') || url.includes('.mp4?') || url.includes('mime=video%2Fmp4')) {
      return 'mp4';
    }

    return null;
  }

  static async resolveSource(
    mediaUrl: string,
    pageUrl: string,
    options?: {
      durationSeconds?: number;
      contentType?: string;
      title?: string;
      videoIndex?: number;
      elementSelector?: string;
      headers?: Record<string, string>;
    }
  ): Promise<DetectedSource> {
    const type = this.identifyType(mediaUrl, options?.contentType) || 'mp4';
    const id = generateId('src');

    let qualities: VideoQuality[] = [];
    let status: 'available' | 'requires_validation' | 'unsupported' = 'available';

    try {
      const backendRes = await ApiClient.resolveSource(mediaUrl, type, pageUrl, options?.headers);
      qualities = backendRes.qualities;
      status = backendRes.status;
      if (backendRes.duration_seconds && !options?.durationSeconds) {
        if (!options) options = {};
        options.durationSeconds = backendRes.duration_seconds;
      }
    } catch (err) {
      console.warn(`[VideoSourceResolver] Backend API probe failed for ${mediaUrl}:`, err);
      status = 'requires_validation';
      qualities = [
        {
          height: 1080,
          label: 'Default Stream (Server Auto)',
          variant_url: mediaUrl,
        },
      ];
    }

    const defaultQuality = qualities.length > 0 ? qualities[0] : null;

    return {
      id,
      page_url: pageUrl,
      media_url: mediaUrl,
      type,
      duration_seconds: options?.durationSeconds,
      qualities,
      selected_quality: defaultQuality,
      status,
      element_selector: options?.elementSelector,
      video_index: options?.videoIndex,
      discovered_at: Date.now(),
      title: options?.title || `Video Source (${type.toUpperCase()})`,
      headers: options?.headers,
    };
  }

  static getDeduplicationKey(url: string): string {
    try {
      const u = new URL(url);
      u.searchParams.delete('_');
      u.searchParams.delete('t');
      u.searchParams.delete('rnd');
      u.searchParams.delete('nocache');
      return `${u.origin}${u.pathname}`;
    } catch {
      return url.split('?')[0];
    }
  }
}
