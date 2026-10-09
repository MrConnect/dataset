# Video Dataset Tagger

## Overview
**Video Dataset Tagger** is a specialized full-stack tool designed to streamline the creation of video datasets for Machine Learning. It allows users to cut, tag, and organize video segments directly from web streaming platforms (or local uploads) into a structured dataset.

The system consists of two main components:
1. **Chrome Extension (Frontend):** Injects a tagging UI overlay into web video players (HTML5, Video.js, JWPlayer). It allows the user to mark "Start" and "End" times, assign category labels, and submit processing jobs.
2. **FastAPI Server (Backend):** Receives jobs, fetches the media stream (using `yt-dlp` or direct `ffmpeg` pipelines), extracts the exact video segments, and organizes them into category folders. It also hosts a Windows Explorer-style Web Dashboard for managing the dataset.

## Architecture & Tech Stack
*   **Backend:** Python 3.12, FastAPI, SQLAlchemy (Async), SQLite (`aiosqlite`), FFmpeg, `yt-dlp`, Uvicorn.
*   **Extension:** TypeScript, React (Sidepanel), TailwindCSS, Vite, Chrome Manifest V3.
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

### 2. The "IP-Lock / Cloudflare" Bypass Workflow (Upload Video)
Many pirate or private streaming sites protect their `m3u8` streams using **IP-Locked JWT Tokens** and **Cloudflare Turnstile**, which block automated server downloads (403 Forbidden). 
**Solution:** 
1. The user downloads the full video locally (e.g., via IDM) using their own home IP.
2. The user opens the Backend Dashboard and uses the **"Upload Video"** button.
3. The video is saved to `System Downloads`.
4. The user clicks the video in the dashboard to play it. The Chrome Extension automatically detects it, allowing the user to tag and submit it directly on the server without any external IP blocking.

### 3. Dataset Operations Dashboard
A built-in GUI at `/dashboard/index.html` for monitoring jobs, checking service health, and managing output files. The library supports familiar Explorer interactions:
*   Click, `Ctrl+Click`, and `Shift+Click` selection; `Ctrl+A` selects the visible files.
*   `Enter` previews, `Delete` removes, and `M` opens move/rename.
*   `Ctrl+X` then `Ctrl+V` moves files into the selected category.
*   Bulk delete and move use single API operations; thumbnails do not preload full media files.
*   The live SQLite database is protected from dashboard delete and move operations.

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
6. Open the extension options/popup and set your Backend URL (e.g., `http://localhost:8000`).

## Known Limitations & Design Decisions
*   **No Headless Browser on Backend:** We intentionally removed server-side browser automation (Playwright) because streaming sites heavily use Cloudflare Data Center IP blocks. The manual Upload feature is the designated fallback for heavily protected sites.
*   **Database Constraints:** The `JobSegment` model relies on `cascade="all, delete-orphan"`. Deleting a job from the UI will completely wipe its associated cuts and segments from the DB.
*   **FFmpeg Bitstream Filters:** `-bsf:a aac_adtstoasc` was removed from the downloader to prevent Exit Code 8 crashes on non-AAC streams.

---
*Maintained by the Video Dataset Tagger Team.*
