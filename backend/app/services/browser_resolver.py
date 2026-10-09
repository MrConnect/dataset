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
            browser = await p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-setuid-sandbox'])
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
            )
            page = await context.new_page()
            
            target_m3u8 = None
            referer = page_url
            
            async def handle_request(request):
                nonlocal target_m3u8, referer
                if request.resource_type in ["xhr", "fetch"] or request.url.endswith(".m3u8") or ".m3u8" in request.url:
                    if "master.m3u8" in request.url or "index.m3u8" in request.url or "playlist.m3u8" in request.url or ".m3u8" in request.url:
                        # Prevent picking up ad tracking m3u8s if possible, just take the first valid looking one
                        if target_m3u8 is None:
                            target_m3u8 = request.url
                            headers = request.headers
                            if "referer" in headers:
                                referer = headers["referer"]
                        
            page.on("request", handle_request)
            
            try:
                await page.goto(page_url, wait_until="domcontentloaded", timeout=15000)
                
                # Attempt to click a play button if present to trigger stream
                try:
                    await page.click('button', timeout=2000)
                except:
                    pass
                try:
                    # Generic play buttons overlay
                    await page.click('.jw-icon-display', timeout=2000)
                except:
                    pass
                    
                for _ in range(30):
                    if target_m3u8:
                        break
                    await asyncio.sleep(0.5)
            except Exception as e:
                logger.warning(f"BrowserResolver encountered an error: {e}")
            finally:
                await browser.close()
                
            return target_m3u8, referer
