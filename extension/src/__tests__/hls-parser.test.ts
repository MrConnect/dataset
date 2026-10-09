import { describe, it, expect } from 'vitest';
import { parseHlsManifest, hlsVariantsToQualities } from '../parsers/hls';

describe('HLS Parser', () => {
  it('parses Master Playlist with multiple variants', () => {
    const masterM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480,CODECS="avc1.4d401f,mp4a.40.2"
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,FRAME-RATE=29.970,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2"
1080p/index.m3u8
`;

    const parsed = parseHlsManifest(masterM3u8, 'https://cdn.example.com/live/master.m3u8');
    expect(parsed.isMaster).toBe(true);
    expect(parsed.variants.length).toBe(4);

    expect(parsed.variants[0].height).toBe(360);
    expect(parsed.variants[0].uri).toBe('https://cdn.example.com/live/360p/index.m3u8');

    expect(parsed.variants[2].height).toBe(720);
    expect(parsed.variants[2].frameRate).toBe(29.97);

    expect(parsed.variants[3].height).toBe(1080);
    expect(parsed.variants[3].bandwidth).toBe(5000000);

    const qualities = hlsVariantsToQualities(parsed);
    expect(qualities.length).toBe(4);
    // Qualities sorted descending by height
    expect(qualities[0].height).toBe(1080);
    expect(qualities[3].height).toBe(360);
  });

  it('parses Media Playlist with chunks', () => {
    const mediaM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
segment1.ts
#EXTINF:9.009,
segment2.ts
#EXT-X-ENDLIST
`;

    const parsed = parseHlsManifest(mediaM3u8, 'https://cdn.example.com/vod/stream.m3u8');
    expect(parsed.isMaster).toBe(false);
    expect(parsed.mediaPlaylists.length).toBe(2);
    expect(parsed.mediaPlaylists[0]).toBe('https://cdn.example.com/vod/segment1.ts');
  });
});
