export type SourceType = 'mp4' | 'hls' | 'dash';

export type SourceStatus = 'available' | 'requires_validation' | 'unsupported';

export type JobStatus =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'processing'
  | 'awaiting_source'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export interface Category {
  id: string;
  name: string;
  color: string;
  description?: string;
  shortcut?: string;
}

export interface VideoQuality {
  height?: number;
  width?: number;
  bandwidth?: number;
  codecs?: string;
  label?: string;
  representation_id?: string | null;
  variant_url?: string | null;
  audio_url?: string | null;
}

export interface DetectedSource {
  id: string; // unique identifier per detected media instance
  page_url: string;
  media_url: string;
  type: SourceType;
  duration_seconds?: number;
  qualities: VideoQuality[];
  selected_quality?: VideoQuality | null;
  status: SourceStatus;
  element_selector?: string;
  video_index?: number;
  discovered_at: number;
  title?: string;
  headers?: Record<string, string>;
}

export interface Segment {
  id: string;
  start_seconds: number;
  end_seconds: number;
  categories: string[]; // category IDs
  notes?: string;
}

export interface TaggingSession {
  id: string; // typically page_url + video_id
  page_url: string;
  video_id: string;
  source: DetectedSource;
  segments: Segment[];
  last_updated: number;
  last_job_id?: string;
  last_job_status?: JobStatus;
}

export interface JobPayload {
  schema_version: '2.0';
  source: {
    page_url: string;
    media_url: string;
    type: SourceType;
    duration_seconds?: number;
    headers?: Record<string, string>;
    acquisition_mode?: 'auto' | 'server' | 'upload';
  };
  quality: {
    height?: number;
    representation_id?: string | null;
    variant_url?: string | null;
  };
  segments: {
    id: string;
    start_seconds: number;
    end_seconds: number;
    categories: string[];
  }[];
  categories_metadata?: Category[];
}

export interface JobResponse {
  job_id: string;
  status: JobStatus;
  segments_count: number;
  created_at?: string;
  progress?: number;
  error?: string | null;
  failure_code?: string | null;
  acquisition_mode?: 'server' | 'upload';
  source_required?: boolean;
  segments?: {
    id: string;
    start_seconds: number;
    end_seconds: number;
    categories: string[];
    status: string;
    output_path?: string | null;
    duration?: number | null;
    error?: string | null;
  }[];
  results?: {
    category_id: string;
    segment_id: string;
    output_path: string;
  }[];
}

export interface ExtensionSettings {
  api_base_url: string;
  api_key: string;
  default_quality_height: number;
  default_category_id: string;
  auto_detection_enabled: boolean;
  show_floating_overlay: boolean;
  shortcuts: {
    mark_start: string;
    mark_end: string;
    save_segment: string;
    cancel_selection: string;
  };
}

// Background to Content / Sidepanel message protocols
export type ExtensionMessage =
  | { type: 'NETWORK_SOURCE_DETECTED'; payload: { url: string; initiator?: string; method?: string } }
  | { type: 'DOM_VIDEOS_FOUND'; payload: { videos: Array<{ index: number; src: string; current_src: string; duration: number; current_time: number; paused: boolean }> } }
  | { type: 'VIDEO_TIME_UPDATE'; payload: { video_index: number; current_time: number; duration: number } }
  | { type: 'SEEK_VIDEO'; payload: { video_index: number; time: number } }
  | { type: 'PLAY_PAUSE_VIDEO'; payload: { video_index: number } }
  | { type: 'TAG_START_FROM_PAGE'; payload: {} }
  | { type: 'TAG_END_FROM_PAGE'; payload: {} }
  | { type: 'SAVE_SEGMENT_FROM_PAGE'; payload: {} }
  | { type: 'GET_ACTIVE_TAB_DATA'; payload: {} }
  | { type: 'ACTIVE_TAB_DATA_RESPONSE'; payload: { sources: DetectedSource[]; active_source_id?: string } };
