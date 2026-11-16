import { describe, expect, it } from 'vitest';
import { VideoSourceResolver } from '../services/source-resolver';


describe('VideoSourceResolver.identifyType', () => {
  it('detects extension-less HLS manifest routes', () => {
    expect(
      VideoSourceResolver.identifyType('https://cdn.example.com/manifest/episode?token=abc')
    ).toBe('hls');
  });

  it('uses response content type when the URL is opaque', () => {
    expect(
      VideoSourceResolver.identifyType(
        'https://cdn.example.com/resource/7f3a9',
        'application/vnd.apple.mpegurl'
      )
    ).toBe('hls');
  });

  it('ignores stream segments disguised as images under /hls/', () => {
    const segment = 'https://img.hscow.com/hls/0a8a6f66/720/s_0.jpg?t=1777024684';
    expect(VideoSourceResolver.identifyType(segment, 'application/octet-stream')).toBeNull();
    expect(VideoSourceResolver.identifyType('https://cdn.example.com/hls/720/seg-12.ts')).toBeNull();
    expect(VideoSourceResolver.identifyType('https://cdn.example.com/hls/v/init.m4s', 'video/mp4')).toBeNull();
  });

  it('still detects the playlist on the same host', () => {
    const playlist = 'https://img1.hscow.com/hls/0a8a6f66/720/index_287.m3u8?Expires=1&Signature=x';
    expect(VideoSourceResolver.identifyType(playlist, 'application/octet-stream')).toBe('hls');
    expect(VideoSourceResolver.identifyType('https://cdn.example.com/hls/stream', 'application/vnd.apple.mpegurl')).toBe('hls');
  });

  it('does not classify ordinary API requests as video', () => {
    expect(
      VideoSourceResolver.identifyType('https://example.com/api/show/123', 'application/json')
    ).toBeNull();
  });
});
