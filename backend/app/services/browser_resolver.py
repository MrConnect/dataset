import asyncio
import logging

from playwright.async_api import async_playwright


logger = logging.getLogger(__name__)


class BrowserResolver:
    """Resolve a fresh, server-IP-bound media URL from a streaming page."""

    @staticmethod
    async def resolve_m3u8(page_url: str, preferred_server: str = "Server 5") -> tuple[str | None, dict[str, str]]:
        captured_url: str | None = None
        captured_headers: dict[str, str] = {}

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--autoplay-policy=no-user-gesture-required",
                    "--mute-audio",
                ],
            )
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/129.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 720},
            )
            page = await context.new_page()

            async def capture_request(request) -> None:
                nonlocal captured_url, captured_headers
                url = request.url
                if captured_url is not None or ".m3u8" not in url.lower():
                    return
                captured_url = url
                request_headers = await request.all_headers()
                for name in ("referer", "origin", "user-agent", "cookie"):
                    value = request_headers.get(name)
                    if value:
                        captured_headers[name.title()] = value
                logger.info("Captured server-side HLS URL from %s", request.frame.url)

            page.on("request", capture_request)

            try:
                await page.goto(page_url, wait_until="domcontentloaded", timeout=30_000)

                server_button = page.get_by_role("button", name=preferred_server, exact=True)
                if await server_button.count():
                    await server_button.click(timeout=10_000)

                # Let the selected provider build its nested iframe chain.
                await page.wait_for_timeout(4_000)

                # Trigger playback in the deepest visible player frame. Popups are
                # isolated in this disposable context and do not affect the job.
                for _ in range(4):
                    if captured_url:
                        break
                    for frame in reversed(page.frames):
                        try:
                            play = frame.get_by_role("button", name="Play", exact=True)
                            if await play.count():
                                await play.first.click(force=True, timeout=1_500)
                                break
                        except Exception:
                            continue
                    await page.wait_for_timeout(2_000)

                for _ in range(15):
                    if captured_url:
                        break
                    await asyncio.sleep(1)
            except Exception as exc:
                logger.warning("Server-side browser resolution failed for %s: %s", page_url, exc)
            finally:
                await browser.close()

        return captured_url, captured_headers
