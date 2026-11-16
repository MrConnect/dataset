# Video Dataset Tagger

## Overview
**Video Dataset Tagger** is a specialized full-stack tool designed to streamline the creation of video datasets for Machine Learning. It allows users to cut, tag, and organize video segments directly from web streaming platforms (or local uploads) into a structured dataset.

The system consists of two main components:
1. **Chrome Extension (Frontend):** Injects a tagging UI overlay into web video players (HTML5, Video.js, JWPlayer). It allows the user to mark "Start" and "End" times, assign category labels, and submit processing jobs.
2. **FastAPI Server (Backend):** Receives jobs, fetches the media stream (using `yt-dlp` or direct `ffmpeg` pipelines), extracts the exact video segments, and organizes them into category folders. It also hosts a Windows Explorer-style Web Dashboard for managing the dataset.

## Architecture & Tech Stack
*   **Backend:** Python 3.12, FastAPI, SQLAlchemy (Async), SQLite (`aiosqlite`), FFmpeg, `yt-dlp`, Uvicorn.
*   **Extension:** TypeScript, React (Sidepanel), Vite, Manifest V3 (Chrome / Edge).
*   **Deployment:** Docker, optimized for Coolify.

## Project Structure
```text
.
├── backend/
│   ├── app/
│   │   ├── api/          # FastAPI routes (dataset, jobs, categories)
│   │   ├── models/       # SQLAlchemy models (Jobs, Categories)
│   │   ├── services/     # Core logic (Downloader, VideoProcessor, HLS/MP4 resolvers)
│   │   └── workers/      # Async queue processing
│   ├── static/           # Dashboard UI (index.html, JS, CSS)
│   ├── Dockerfile        # Backend container definition
│   └── requirements.txt  # Python dependencies
└── extension/
    ├── src/
    │   ├── content/      # Content scripts (UI injection, video detection)
    │   ├── sidepanel/    # React-based sidepanel for Job Status/Management
    │   └── background/   # Service worker for cross-origin requests & state
    ├── manifest.json
    └── vite.config.ts    # Extension build config
```

## Key Workflows & Features

### Acquisition Architecture (Schema 2.0)

Media acquisition and dataset processing are separate phases:

1. The extension observes the real media request and preserves its `Referer`, `Origin`, and `User-Agent` context.
2. The backend first attempts server-side acquisition for ordinary MP4, HLS, and DASH sources.
3. Authentication, session, or IP-bound failures do not destroy the job. The job moves to `awaiting_source` with a stable failure code.
4. The user uploads the source file from the Jobs panel. The same job resumes automatically and keeps its original segments and labels.
5. Processing runs against a verified local source, so cutting and dataset storage are independent of the streaming provider.

This design does not assume that every browser-visible stream can be fetched from a datacenter IP. Provider-specific behavior is contained in discovery; the processing pipeline stays provider-agnostic.

### 1. Standard Web Tagging
1. User navigates to a supported streaming site.
2. The extension detects the video player and overlays the tagging UI.
3. User creates segments, assigns labels (synced from the backend database), and clicks "Submit".
4. The backend downloads the source video into `_downloads` and uses `ffmpeg` to precisely extract and save the segments into `_dataset/<category>`.

### Tagging on the player
*   Mark a start (`[`), an end (`]`) and save (`Enter`). The segments panel always lists segments in video order and highlights the one under the playhead.
*   Click a segment (in the panel or on the progress bar) to edit it: type exact times (`1:23.5`), nudge with `↑`/`↓` (Shift ×10, Alt ÷10), set an edge to the playhead, play just that segment, or relabel it. While a segment is selected, `[` and `]` move its edges directly.
*   `Del` deletes the selected segment; every change can be undone with `Ctrl+Z` or the Undo button. `,` / `.` step one frame.

### 2. Uploading the source video yourself
Some streams are bound to the browser session or IP that requested them, so the server cannot fetch them (403). In that case the job moves to `awaiting_source` and you supply the file:

1. Download the full video on your own machine.
2. In the extension's Jobs panel (or the dashboard's Processing jobs view) click **Upload source** on that job.
3. The browser sends the file in resumable chunks (`/api/v1/uploads`). A dropped connection or proxy timeout only repeats the current chunk.
4. The server verifies the finished file with FFprobe — it must be a playable video and long enough for every tagged segment — then resumes the same job and cuts frame-accurately from the local file.

A file that is too short for the job's segments is rejected with an explanation instead of producing wrong cuts. If its length merely differs from the tagged stream, the job runs and carries a warning.

You can also add a video to the library first (**Upload video** in the dashboard), play it there and tag it with the extension; the server then cuts the stored file directly.

### 3. Dataset Operations Dashboard
A built-in GUI at `/dashboard/index.html` for monitoring jobs, checking service health, and managing output files. The library behaves like a file manager:
*   Click, `Ctrl+Click`, `Shift+Click` and arrow keys select; `Ctrl+A` selects everything shown.
*   `Enter` previews, `F2` (or double-clicking the name) renames in place, `M` moves, `Delete` removes.
*   Drag clips onto a category to move them, or `Ctrl+X` then `Ctrl+V` inside a category. Right-click opens the same actions.
*   Drop video files anywhere on the page to upload them (resumable, verified on the server).
*   **Thumbnails** are rendered once, in the background, right after a video is created (a cut clip, a downloaded or uploaded source) — one FFmpeg process at a time at low priority — and cached under `<storage>/thumbs`. Missing ones are rebuilt at startup and hourly. The cache mirrors the library, so deleting, moving and renaming a file deletes or carries its thumbnail with it; replaced files are re-rendered and orphans are swept hourly.
*   The SQLite database is not part of the file library. Admins download a backup or reset it from **System & connection → Job database**.
*   Server-downloaded and uploaded source videos are kept in `Source videos` under the job ID so the input can be inspected alongside its cuts.

## Security & access

*   **Everything requires a key.** All API routes (jobs, dataset, uploads, files) need the `X-API-Key` header. Only `/api/v1/health` and the static dashboard shell are public.
*   **Admin key.** Set `API_KEY` in the environment. If it is empty the server generates one on first start, prints it in the log and stores it in `<storage>/admin_key.txt`. There is no built-in default key.
*   **Client keys.** In the dashboard open **System & connection → Client keys** and generate one key per extension. Paste it into the extension settings. Client keys can use the pipeline but cannot manage keys or the database, are stored only as hashes, and can be revoked individually.
*   **Files.** Storage is never mounted as static files. Clips are served by `/api/v1/dataset/file/...`, which accepts the key header or a short-lived HttpOnly cookie that the dashboard obtains in exchange for a valid key (read-only, never accepted for changes).
*   **Use HTTPS** in front of the server (Coolify/Traefik does this) so the key and uploads are encrypted in transit. The extension warns when the configured URL is plain HTTP on a non-local host.
*   **Outbound requests** are checked against an anti-SSRF policy on every hop, including redirects. Downloads delegated to `yt-dlp`/`ffmpeg` are validated before they start.

## Reliability

*   **The queue lives in the database.** A job is queued by its `status` column; workers claim jobs atomically. Jobs that were running when the server stopped are re-queued on the next start.
*   **Downloads are supervised.** A download is stopped when it makes no progress for `DOWNLOAD_STALL_TIMEOUT_SECONDS`, exceeds `MAX_DURATION_SECONDS`, or grows past `MAX_DOWNLOAD_SIZE_BYTES` (also for HLS/DASH). Cancelling a job kills its download.
*   **Incomplete downloads are not treated as success.** If the download tool exits with an error, the file is used only when it still covers every tagged segment; otherwise the job asks for a source upload.

## Setup & Installation

### Backend
The backend is Dockerized and ready for deployment (e.g., via Coolify).
To run locally:
```bash
cd backend
python -m venv venv
source venv/bin/activate  # (or venv\Scripts\activate on Windows)
pip install -r requirements.txt
uvicorn app.main:app --reload
```
*Note: Ensure `ffmpeg` and `ffprobe` are installed on your system.*

### Extension
1. Ensure Node.js is installed.
2. Build the extension:
```bash
cd extension
npm install
npm run build
```
3. Open Chrome and navigate to `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the `extension/dist` folder.
6. Open the extension settings, set your Backend URL (e.g., `https://tagger.example.com`) and paste a client key generated in the dashboard.

## Known Limitations & Design Decisions
*   **No Headless Browser on Backend:** We intentionally removed server-side browser automation (Playwright) because streaming sites heavily use Cloudflare Data Center IP blocks. The manual Upload feature is the designated fallback for heavily protected sites.
*   **Database Constraints:** The `JobSegment` model relies on `cascade="all, delete-orphan"`. Deleting a job from the UI will completely wipe its associated cuts and segments from the DB.
*   **FFmpeg Bitstream Filters:** `-bsf:a aac_adtstoasc` was removed from the downloader to prevent Exit Code 8 crashes on non-AAC streams.

---
*Maintained by the Video Dataset Tagger Team.*
