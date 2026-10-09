import asyncio
from playwright.async_api import async_playwright
import logging

logger = logging.getLogger(__name__)

class BrowserResolver:
    @staticmethod
    async def resolve_m3u8(page_url: str) -> tuple[str, str]:
        """
        Uses Playwright to visit the page URL and intercept the m3u8 network request.
        Returns (m3u8_url, referer_header).
        """
        async with async_playwright() as p:
            # Bypass autoplay restrictions so video starts instantly
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--autoplay-policy=no-user-gesture-required',
                    '--mute-audio'
                ]
            )
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                viewport={'width': 1280, 'height': 720}
            )
            page = await context.new_page()
            
            target_m3u8 = None
            referer = page_url
            
            async def handle_request(request):
                nonlocal target_m3u8, referer
                url = request.url
                if request.resource_type in ["xhr", "fetch"] or url.endswith(".m3u8") or ".m3u8" in url:
                    if "master.m3u8" in url or "index.m3u8" in url or "playlist.m3u8" in url or ".m3u8" in url:
                        # Prevent picking up ad tracking m3u8s if possible, just take the first valid looking one
                        if target_m3u8 is None and "ad" not in url.lower():
                            target_m3u8 = url
                            headers = request.headers
                            if "referer" in headers:
                                referer = headers["referer"]
                        
            page.on("request", handle_request)
            
            try:
                logger.info(f"Navigating to {page_url} in headless browser...")
                await page.goto(page_url, wait_until="domcontentloaded", timeout=20000)
                
                # AGGRESSIVE AD BYPASS: Find the actual player iframe and navigate directly to it
                # Many streaming sites wrap the player in an iframe and cover it with click-jacking ads
                frames = page.frames
                player_url = None
                for frame in frames:
                    url = frame.url
                    if url and ("player" in url or "embed" in url or "vidcore" in url or "vidsrc" in url):
                        player_url = url
                        break
                
                if player_url and player_url != page.url:
                    logger.info(f"Ad-bypass: Found inner player iframe, navigating directly to {player_url}")
                    await page.goto(player_url, wait_until="domcontentloaded", timeout=15000)
                
                # Try clicking center of screen a few times (to dismiss overlays and click play)
                for _ in range(3):
                    try:
                        await page.mouse.click(640, 360, delay=100)
                        await asyncio.sleep(1)
                    except:
                        pass
                
                # Check for iframes and click inside them too
                for frame in page.frames:
                    try:
                        await frame.click('body', position={'x': 300, 'y': 200}, force=True, timeout=1000)
                    except:
                        pass
                    
                for _ in range(30): # Wait up to 15 seconds
                    if target_m3u8:
                        break
                    await asyncio.sleep(0.5)
            except Exception as e:
                logger.warning(f"BrowserResolver encountered an error: {e}")
            finally:
                await browser.close()
                
            return target_m3u8, referer
