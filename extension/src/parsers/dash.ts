import { VideoQuality } from '../types';
import { resolveRelativeUrl } from './hls';

export interface DashRepresentation {
  id: string;
  contentType: 'video' | 'audio' | 'text' | 'unknown';
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codecs?: string;
  mimeType?: string;
  baseUrl?: string;
}

export interface ParsedDashMpd {
  durationSeconds?: number;
  minBufferTime?: number;
  videoRepresentations: DashRepresentation[];
  audioRepresentations: DashRepresentation[];
}

/**
 * Parses MPEG-DASH XML MPD string into structured representations (ISO/IEC 23009-1)
 */
export function parseDashManifest(xmlContent: string, mpdUrl: string): ParsedDashMpd {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlContent, 'application/xml');

  // Check XML parser errors
  const parseError = xmlDoc.getElementsByTagName('parsererror');
  if (parseError.length > 0) {
    return { videoRepresentations: [], audioRepresentations: [] };
  }

  const mpdRoot = xmlDoc.documentElement;
  if (!mpdRoot || mpdRoot.tagName.toLowerCase() !== 'mpd') {
    return { videoRepresentations: [], audioRepresentations: [] };
  }

  // Parse Media Presentation Duration (e.g. PT1H30M15.5S)
  const mediaPresentationDurationStr = mpdRoot.getAttribute('mediaPresentationDuration');
  const durationSeconds = mediaPresentationDurationStr ? parseIso8601Duration(mediaPresentationDurationStr) : undefined;

  const videoReps: DashRepresentation[] = [];
  const audioReps: DashRepresentation[] = [];

  // BaseURL at MPD level
  let mpdBaseUrl = mpdUrl;
  const rootBaseUrls = mpdRoot.getElementsByTagName('BaseURL');
  if (rootBaseUrls.length > 0 && rootBaseUrls[0].textContent) {
    mpdBaseUrl = resolveRelativeUrl(mpdUrl, rootBaseUrls[0].textContent.trim());
  }

  const periods = xmlDoc.getElementsByTagName('Period');
  const targetPeriods = periods.length > 0 ? Array.from(periods) : [mpdRoot];

  for (const period of targetPeriods) {
    const adaptationSets = period.getElementsByTagName('AdaptationSet');

    for (let i = 0; i < adaptationSets.length; i++) {
      const adapt = adaptationSets[i];
      const adaptContentType = (adapt.getAttribute('contentType') || '').toLowerCase();
      const adaptMimeType = (adapt.getAttribute('mimeType') || '').toLowerCase();
      const adaptWidth = parseInt(adapt.getAttribute('width') || '', 10) || undefined;
      const adaptHeight = parseInt(adapt.getAttribute('height') || '', 10) || undefined;
      const adaptCodecs = adapt.getAttribute('codecs') || undefined;

      let detectedType: 'video' | 'audio' | 'unknown' = 'unknown';
      if (adaptContentType === 'video' || adaptMimeType.startsWith('video/')) {
        detectedType = 'video';
      } else if (adaptContentType === 'audio' || adaptMimeType.startsWith('audio/')) {
        detectedType = 'audio';
      }

      const representations = adapt.getElementsByTagName('Representation');
      for (let j = 0; j < representations.length; j++) {
        const rep = representations[j];
        const repId = rep.getAttribute('id') || `rep_${i}_${j}`;
        const repMimeType = (rep.getAttribute('mimeType') || adaptMimeType).toLowerCase();
        
        let repType = detectedType;
        if (repType === 'unknown') {
          if (repMimeType.startsWith('video/')) repType = 'video';
          else if (repMimeType.startsWith('audio/')) repType = 'audio';
        }

        const width = parseInt(rep.getAttribute('width') || '', 10) || adaptWidth;
        const height = parseInt(rep.getAttribute('height') || '', 10) || adaptHeight;
        const bandwidth = parseInt(rep.getAttribute('bandwidth') || '', 10) || undefined;
        const frameRateStr = rep.getAttribute('frameRate');
        let frameRate: number | undefined;
        if (frameRateStr) {
          if (frameRateStr.includes('/')) {
            const [num, den] = frameRateStr.split('/').map(Number);
            if (den) frameRate = num / den;
          } else {
            frameRate = parseFloat(frameRateStr) || undefined;
          }
        }
        const codecs = rep.getAttribute('codecs') || adaptCodecs;

        // BaseURL inside representation or adaptationSet
        const repBaseUrls = rep.getElementsByTagName('BaseURL');
        let repUrl = mpdBaseUrl;
        if (repBaseUrls.length > 0 && repBaseUrls[0].textContent) {
          repUrl = resolveRelativeUrl(mpdBaseUrl, repBaseUrls[0].textContent.trim());
        }

        const item: DashRepresentation = {
          id: repId,
          contentType: repType,
          bandwidth,
          width,
          height,
          frameRate,
          codecs,
          mimeType: repMimeType,
          baseUrl: repUrl,
        };

        if (repType === 'video' || (repType === 'unknown' && (width || height))) {
          videoReps.push(item);
        } else if (repType === 'audio') {
          audioReps.push(item);
        }
      }
    }
  }

  return {
    durationSeconds,
    videoRepresentations: videoReps,
    audioRepresentations: audioReps,
  };
}

/**
 * Parses ISO 8601 duration strings like PT1H2M3.4S into seconds
 */
export function parseIso8601Duration(isoStr: string): number {
  const match = isoStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!match) return 0;
  const hours = parseFloat(match[1] || '0');
  const minutes = parseFloat(match[2] || '0');
  const seconds = parseFloat(match[3] || '0');
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Converts DASH representations to unified VideoQuality items
 */
export function dashRepresentationsToQualities(mpd: ParsedDashMpd): VideoQuality[] {
  if (mpd.videoRepresentations.length === 0) {
    return [
      {
        height: 720,
        label: 'Auto / Default Representation',
      },
    ];
  }

  // Sort descending by height / bandwidth
  const sorted = [...mpd.videoRepresentations].sort((a, b) => {
    if ((b.height || 0) !== (a.height || 0)) {
      return (b.height || 0) - (a.height || 0);
    }
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });

  return sorted.map((rep) => {
    const label = rep.height
      ? `${rep.height}p${rep.frameRate ? ` @ ${Math.round(rep.frameRate)}fps` : ''} (${rep.bandwidth ? `${Math.round(rep.bandwidth / 1000)}k` : ''})`
      : rep.bandwidth
      ? `${Math.round(rep.bandwidth / 1000)} kbps [${rep.id}]`
      : `Representation ${rep.id}`;

    return {
      height: rep.height,
      width: rep.width,
      bandwidth: rep.bandwidth,
      codecs: rep.codecs,
      label,
      representation_id: rep.id,
      variant_url: rep.baseUrl,
    };
  });
}
