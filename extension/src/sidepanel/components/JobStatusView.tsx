import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Clock,
  Copy,
  Download,
  FileDown,
  FileUp,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { JobResponse, JobStatus } from '../../types';
import { ApiClient } from '../../services/api-client';
import { ConfirmButton, IconButton, IconFileButton, useNotify } from './ui';

interface JobStatusViewProps {
  lastSubmittedJobId?: string | null;
}

const STATUS: Record<string, { label: string; icon: LucideIcon; tone: string; spin?: boolean }> = {
  queued: { label: 'Queued', icon: Clock, tone: 'info' },
  downloading: { label: 'Downloading', icon: Download, tone: 'info' },
  processing: { label: 'Processing', icon: Loader2, tone: 'info', spin: true },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'ok' },
  partially_completed: { label: 'Partly done', icon: AlertTriangle, tone: 'warn' },
  awaiting_source: { label: 'Needs source', icon: Upload, tone: 'warn' },
  failed: { label: 'Failed', icon: CircleX, tone: 'bad' },
  cancelled: { label: 'Cancelled', icon: CircleX, tone: 'muted' },
};

const FINISHED: JobStatus[] = ['completed', 'partially_completed', 'failed', 'cancelled'];

function sourceName(job: JobResponse): string {
  try {
    return new URL(job.page_url || job.media_url || '').hostname.replace(/^www\./, '');
  } catch {
    return job.job_id;
  }
}

export const JobStatusView: React.FC<JobStatusViewProps> = ({ lastSubmittedJobId }) => {
  const notify = useNotify();
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingJob, setUploadingJob] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ percent: number; text: string }>({ percent: 0, text: '' });
  const [deletingJob, setDeletingJob] = useState<string | null>(null);

  const fetchJobs = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const list = await ApiClient.listJobs(10, 0);
      setJobs(list);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch jobs from backend');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await fetchJobs(false);
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    void fetchJobs().finally(() => { if (!stopped) timer = setTimeout(poll, 5000); });
    return () => { stopped = true; clearTimeout(timer); };
  }, [lastSubmittedJobId]);

  const handleCancelJob = async (jobId: string) => {
    try {
      await ApiClient.cancelJob(jobId);
      notify('Job cancelled');
      void fetchJobs(false);
    } catch (err: any) {
      notify(`Could not cancel: ${err.message}`, 'error');
    }
  };

  const handleUndoJob = async (jobId: string) => {
    setDeletingJob(jobId);
    try {
      const result = await ApiClient.deleteJob(jobId);
      await fetchJobs(false);
      const megabytes = (result.deleted_bytes / (1024 * 1024)).toFixed(1);
      notify(`Job removed — ${result.deleted_files} files (${megabytes} MB) deleted`);
    } catch (err: any) {
      notify(`Could not delete: ${err.message}`, 'error');
    } finally {
      setDeletingJob(null);
    }
  };

  const handleSourceUpload = async (jobId: string, file: File) => {
    setUploadingJob(jobId);
    setUpload({ percent: 0, text: 'Starting upload…' });
    try {
      const result = await ApiClient.uploadJobSource(jobId, file, (sent, total, verifying) => {
        const percent = Math.floor((sent / total) * 100);
        setUpload({
          percent,
          text: verifying
            ? 'Verifying video on server…'
            : `${percent}% · ${(sent / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`,
        });
      });
      await fetchJobs(false);
      notify(result.warning || 'Source verified — job resumed', result.warning ? 'error' : 'ok');
    } catch (err: any) {
      notify(`Upload failed: ${err.message}`, 'error');
    } finally {
      setUploadingJob(null);
    }
  };

  const handleExport = (job: JobResponse) => {
    if (!job.segments?.length) {
      notify('This job has no segments to export', 'error');
      return;
    }
    const exportData = job.segments.map((s) => ({ start_seconds: s.start_seconds, end_seconds: s.end_seconds, categories: s.categories }));
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job.job_id}_export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const segments = JSON.parse(ev.target?.result as string);
        if (!Array.isArray(segments)) throw new Error('JSON must be an array of segments');

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs[0];
          if (!activeTab?.id) {
            notify('No active tab to import into', 'error');
            return;
          }
          chrome.tabs.sendMessage(activeTab.id, { type: 'IMPORT_JOB_JSON', payload: { segments } }, (response) => {
            if (chrome.runtime.lastError || !response?.ok) {
              notify('Open a page with a detected video first, then import again', 'error');
            } else {
              notify(`${segments.length} segments added to the video timeline`);
            }
          });
        });
      } catch (err: any) {
        notify(`Invalid JSON: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="stack">
      <div className="section-head">
        <span className="section-title">Processing jobs</span>
        <div className="row">
          <IconFileButton icon={FileUp} label="Import segments from JSON into the open video" accept=".json" onFile={handleImportJson} />
          <IconButton icon={RefreshCw} label="Refresh" spinning={loading} disabled={loading} onClick={() => void fetchJobs()} />
        </div>
      </div>

      {error && (
        <div className="banner bad">
          <AlertTriangle size={14} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {jobs.length === 0 && !error ? (
        <div className="empty-state">
          <Clock size={26} aria-hidden />
          <strong>No jobs yet</strong>
          <span>Tag segments on a video and send them to the server.</span>
        </div>
      ) : (
        jobs.map((job) => {
          const status = STATUS[job.status] || { label: job.status, icon: Clock, tone: 'muted' };
          const StatusIcon = status.icon;
          const isFinished = FINISHED.includes(job.status);
          const needsSource = job.status === 'awaiting_source' || job.source_required;
          const isRunning = ['queued', 'downloading', 'processing'].includes(job.status);
          const isUploading = uploadingJob === job.job_id;
          const progress = isUploading ? upload.percent : job.progress ?? 0;

          return (
            <article key={job.job_id} className={`job-card tone-${status.tone}`}>
              <div className="job-top">
                <div className="job-title">
                  <strong title={job.page_url || job.job_id}>{sourceName(job)}</strong>
                  <small>
                    {job.segments_count} {job.segments_count === 1 ? 'segment' : 'segments'} · {job.job_id.slice(-6)}
                  </small>
                </div>
                <span className={`status-pill tone-${status.tone}`}>
                  <StatusIcon size={12} className={status.spin ? 'spin' : undefined} aria-hidden />
                  {status.label}
                </span>
              </div>

              {(isRunning || isUploading) && (
                <div className="progress-track" title={`${progress}%`}>
                  <div style={{ width: `${progress}%` }} />
                </div>
              )}

              {isUploading && <div className="job-message info">{upload.text}</div>}
              {!isUploading && job.error && (
                <div className={`job-message ${needsSource ? 'warn' : 'bad'}`}>{job.error}</div>
              )}

              <div className="job-actions">
                {needsSource && (
                  <IconFileButton
                    icon={Upload}
                    label="Upload the source video and resume this job"
                    accept="video/*,.mkv,.ts,.m4v"
                    variant="primary"
                    disabled={isUploading}
                    onFile={(file) => void handleSourceUpload(job.job_id, file)}
                  />
                )}
                <span className="spacer" />
                <IconButton
                  icon={Copy}
                  label="Copy job ID"
                  variant="ghost"
                  onClick={() => navigator.clipboard.writeText(job.job_id).then(() => notify('Job ID copied'))}
                />
                <IconButton icon={FileDown} label="Export segments as JSON" variant="ghost" onClick={() => handleExport(job)} />
                {!isFinished && (
                  <IconButton icon={CircleX} label="Cancel job" variant="ghost" onClick={() => void handleCancelJob(job.job_id)} />
                )}
                <ConfirmButton
                  icon={Trash2}
                  label="Delete job, its source and its clips"
                  confirmLabel="Click again to delete permanently"
                  disabled={deletingJob === job.job_id}
                  onConfirm={() => void handleUndoJob(job.job_id)}
                />
              </div>
            </article>
          );
        })
      )}
    </div>
  );
};
