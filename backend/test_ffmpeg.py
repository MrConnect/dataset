import asyncio
import sys
from pathlib import Path
from app.services.downloader import VideoDownloader, StreamExtractor
from app.services.video_processor import VideoProcessor
import urllib.request, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

async def test():
    embed_url = 'https://down.vidtube.one/embed-kk4k61vpu5r5.html'
    headers = {'Referer': 'https://web.topcinema.io/'}
    print("Resolving...", flush=True)
    
    url, typ, hdrs = await VideoDownloader.resolve_stream(embed_url, 'hls', None, headers)
    print("Resolved:", url, flush=True)
    print("Headers:", hdrs, flush=True)
    
    out = Path('test_segment.mp4')
    if out.exists():
        out.unlink()
        
    print("Extracting segment (30s to 35s)...", flush=True)
    try:
        dur = await VideoProcessor.extract_segment(url, 30.0, 35.0, out, headers=hdrs)
        print("Extracted duration:", dur, flush=True)
    except Exception as e:
        print("Error during extract:", e, flush=True)

asyncio.run(test())
