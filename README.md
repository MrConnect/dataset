# Video Dataset Tagger

A full-stack solution for seamlessly tagging and extracting frame-accurate video segments directly from HLS/DASH/MP4 streams (e.g. VidTube, TopCinema). Designed for AI dataset preparation (CVAT ready).

## Architecture

The project is split into two parts:
1. **Extension** (`/extension`): A Chrome/Edge extension that detects video streams natively via Network Interception, bypasses CORS, and injects a modern overlay UI directly into the video player (supporting fullscreen on custom players like JWPlayer). Features frame-by-frame seeking and global keyboard shortcuts.
2. **Backend API** (`/backend`): A FastAPI service that securely resolves stream qualities, queues jobs, and executes frame-accurate FFmpeg extractions `-preset ultrafast` to avoid timeouts. Outputs perfectly trimmed `.mp4` segments sorted into categories.

## Keyboard Shortcuts (Inside Video Player)

The extension captures keyboard shortcuts in the capture-phase, bypassing any custom player's own shortcuts regardless of keyboard layout (works natively with English, Arabic, etc.).

- `I` or `[`: Mark Segment Start (In)
- `O` or `]`: Mark Segment End (Out)
- `,` (Comma): Step Backward 1 frame
- `.` (Period): Step Forward 1 frame
- `Enter`: Save Segment
- `Escape`: Cancel/Clear markers

## Setup Instructions

### 1. Backend (FastAPI + FFmpeg)

Prerequisites: Python 3.12, FFmpeg installed and in PATH.

```bash
cd backend
python -m venv .venv
# Activate venv:
# Windows: .venv\Scripts\activate
# Linux/Mac: source .venv/bin/activate
pip install -r requirements.txt

# Run the backend daemon
uvicorn app.main:app --port 8000
```

### 2. Extension (Chrome / Edge)

Prerequisites: Node.js 18+

```bash
cd extension
npm install
npm run build
```

Then, load the extension into your browser:
1. Open `edge://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `video-dataset-tagger/extension/dist` folder.

## Workflow

1. Navigate to a supported streaming site (e.g., TopCinema).
2. Start playing the video.
3. The Video Tagger UI will automatically inject itself into the video player.
4. Select your preferred Quality from the top-left dropdown.
5. Use shortcuts to tag segments.
6. Click **Send Segments to Backend API**.
7. The Backend will download and cut the segments seamlessly!

## License

MIT
