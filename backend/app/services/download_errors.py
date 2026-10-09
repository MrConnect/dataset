import re


class DownloadFailure(RuntimeError):
    """A normalized acquisition failure the API can turn into an action."""

    def __init__(self, code: str, message: str, *, source_required: bool = False):
        super().__init__(message)
        self.code = code
        self.source_required = source_required


def classify_download_error(error: Exception) -> DownloadFailure:
    message = str(error)
    lowered = message.lower()

    if re.search(r"\b(401|403)\b", message) or "forbidden" in lowered or "access denied" in lowered:
        return DownloadFailure(
            "SOURCE_ACCESS_DENIED",
            "The stream is restricted to the browser session or IP. Upload the source video to continue this job.",
            source_required=True,
        )
    if "timed out" in lowered or "timeout" in lowered:
        return DownloadFailure("SOURCE_TIMEOUT", "The source download timed out. Retry or upload the source video.")
    if "invalid data" in lowered or "ffprobe" in lowered:
        return DownloadFailure(
            "SOURCE_INVALID",
            "The captured URL did not return playable media. Select another source or upload the video.",
            source_required=True,
        )
    if "incomplete or mismatched" in lowered or "no playable video stream" in lowered:
        return DownloadFailure(
            "SOURCE_INCOMPLETE",
            f"{message} Upload a verified source video to continue.",
            source_required=True,
        )
    return DownloadFailure("SOURCE_DOWNLOAD_FAILED", message)
