import { VideoQuality } from '../types';

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroupId?: string;
  audioUri?: string;
}

export interface ParsedHlsPlaylist {
  isMaster: boolean;
  targetDuration?: number;
  variants: HlsVariant[];
  mediaPlaylists: string[];
}

/**
 * Resolves a potentially relative URI against a base URL
 */
export function resolveRelativeUrl(baseUrl: string, relativeUrl: string): string {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return relativeUrl;
  }
}

/**
 * Parses HLS M3U8 string into structured playlist variants (RFC 8216 compliant)
 */
export function parseHlsManifest(content: string, manifestUrl: string): ParsedHlsPlaylist {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    // If it doesn't start with #EXTM3U, it might still be a media segment or invalid
    return { isMaster: false, variants: [], mediaPlaylists: [] };
  }

  let isMaster = false;
  const variants: HlsVariant[] = [];
  const mediaPlaylists: string[] = [];
  const audioMap = new Map<string, string>(); // groupId -> audioUri

  let currentStreamInf: {
    bandwidth?: number;
    averageBandwidth?: number;
    width?: number;
    height?: number;
    codecs?: string;
    frameRate?: number;
    audioGroupId?: string;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Audio / Alternative media renditions
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.substring(13));
      if (attributes['TYPE'] === 'AUDIO' && attributes['GROUP-ID'] && attributes['URI']) {
        const audioUri = resolveRelativeUrl(manifestUrl, attributes['URI']);
        audioMap.set(attributes['GROUP-ID'], audioUri);
      }
    }

    // Stream Inf for Master Playlist
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const attributes = parseAttributeList(line.substring(18));
      
      let width: number | undefined;
      let height: number | undefined;
      if (attributes['RESOLUTION']) {
        const parts = attributes['RESOLUTION'].split('x');
        if (parts.length === 2) {
          width = parseInt(parts[0], 10) || undefined;
          height = parseInt(parts[1], 10) || undefined;
        }
      }

      currentStreamInf = {
        bandwidth: attributes['BANDWIDTH'] ? parseInt(attributes['BANDWIDTH'], 10) : undefined,
        averageBandwidth: attributes['AVERAGE-BANDWIDTH'] ? parseInt(attributes['AVERAGE-BANDWIDTH'], 10) : undefined,
        width,
        height,
        codecs: attributes['CODECS'],
        frameRate: attributes['FRAME-RATE'] ? parseFloat(attributes['FRAME-RATE']) : undefined,
        audioGroupId: attributes['AUDIO'],
      };
      continue;
    }

    // Next line after #EXT-X-STREAM-INF is the variant URI
    if (currentStreamInf && !line.startsWith('#')) {
      const fullUri = resolveRelativeUrl(manifestUrl, line);
      variants.push({
        uri: fullUri,
        ...currentStreamInf,
        audioUri: currentStreamInf.audioGroupId ? audioMap.get(currentStreamInf.audioGroupId) : undefined,
      });
      currentStreamInf = null;
      continue;
    }

    // Single Media Playlist segments tag
    if (line.startsWith('#EXTINF:')) {
      // This is a Media Playlist
      if (!isMaster) {
        // Collect media playlist
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          mediaPlaylists.push(resolveRelativeUrl(manifestUrl, nextLine));
        }
      }
    }
  }

  // Backfill audio URIs in case audio tags came after stream-inf
  for (const v of variants) {
    if (v.audioGroupId && !v.audioUri && audioMap.has(v.audioGroupId)) {
      v.audioUri = audioMap.get(v.audioGroupId);
    }
  }

  return {
    isMaster,
    variants,
    mediaPlaylists,
  };
}

/**
 * Parses RFC 8216 attribute-list (e.g. BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2")
 */
function parseAttributeList(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  let key = '';
  let value = '';
  let inQuotes = false;
  let readingKey = true;

  for (let i = 0; i < attrStr.length; i++) {
    const char = attrStr[i];

    if (char === '=' && readingKey) {
      readingKey = false;
      continue;
    }

    if (char === '"' && !readingKey) {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      if (key.trim()) {
        result[key.trim()] = value.trim();
      }
      key = '';
      value = '';
      readingKey = true;
      continue;
    }

    if (readingKey) {
      key += char;
    } else {
      value += char;
    }
  }

  if (key.trim()) {
    result[key.trim()] = value.trim();
  }

  return result;
}

/**
 * Converts parsed variants to unified VideoQuality items
 */
export function hlsVariantsToQualities(manifest: ParsedHlsPlaylist): VideoQuality[] {
  if (!manifest.isMaster || manifest.variants.length === 0) {
    return [
      {
        height: 720,
        label: 'Auto / Default Stream',
      },
    ];
  }

  // Sort descending by height / bandwidth
  const sorted = [...manifest.variants].sort((a, b) => {
    if ((b.height || 0) !== (a.height || 0)) {
      return (b.height || 0) - (a.height || 0);
    }
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });

  return sorted.map((variant) => {
    const label = variant.height
      ? `${variant.height}p${variant.frameRate ? ` @ ${Math.round(variant.frameRate)}fps` : ''} (${variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)}k` : ''})`
      : variant.bandwidth
      ? `${Math.round(variant.bandwidth / 1000)} kbps`
      : 'Stream Variant';

    return {
      height: variant.height,
      width: variant.width,
      bandwidth: variant.bandwidth,
      codecs: variant.codecs,
      label,
      variant_url: variant.uri,
      audio_url: variant.audioUri,
    };
  });
}
