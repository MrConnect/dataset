import { DetectedSource, SourceType, VideoQuality } from '../types';
import { generateId } from '../utils/uuid';
import { ApiClient } from './api-client';

export class VideoSourceResolver {
  static identifyType(url: string, contentType?: string): SourceType | null {
    const cleanUrl = url.toLowerCase().split('?')[0];

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
