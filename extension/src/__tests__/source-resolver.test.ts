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

  it('does not classify ordinary API requests as video', () => {
    expect(
      VideoSourceResolver.identifyType('https://example.com/api/show/123', 'application/json')
    ).toBeNull();
  });
});
