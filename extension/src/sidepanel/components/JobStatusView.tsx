import React, { useEffect, useState } from 'react';
import { JobResponse, JobStatus } from '../../types';
import { ApiClient } from '../../services/api-client';

interface JobStatusViewProps {
  lastSubmittedJobId?: string | null;
}

export const JobStatusView: React.FC<JobStatusViewProps> = ({ lastSubmittedJobId }) => {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingJob, setUploadingJob] = useState<string | null>(null);

  const fetchJobs = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await ApiClient.listJobs(10, 0);
      setJobs(list);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch jobs from backend');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(() => {
      // Poll active jobs
      fetchJobs();
    }, 4000);
    return () => clearInterval(interval);
  }, [lastSubmittedJobId]);

  const handleCancelJob = async (jobId: string) => {
    try {
      await ApiClient.cancelJob(jobId);
      fetchJobs();
    } catch (err: any) {
      alert(`Error canceling job: ${err.message}`);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!confirm('Are you sure you want to delete this job and all its data?')) return;
    try {
      await ApiClient.deleteJob(jobId);
      fetchJobs();
    } catch (err: any) {
      alert(`Error deleting job: ${err.message}`);
    }
  };

  const handleSourceUpload = async (jobId: string, file?: File) => {
    if (!file) return;
    setUploadingJob(jobId);
    try {
      await ApiClient.uploadJobSource(jobId, file);
      await fetchJobs();
    } catch (err: any) {
      alert(`Source upload failed: ${err.message}`);
    } finally {
      setUploadingJob(null);
    }
  };

  const getStatusColor = (status: JobStatus) => {
    switch (status) {
      case 'completed': return 'var(--accent-green)';
      case 'failed': return 'var(--accent-red)';
      case 'cancelled': return '#64748b';
      case 'awaiting_source': return 'var(--accent-amber)';
      case 'downloading':
      case 'processing': return '#38bdf8';
      default: return 'var(--accent-amber)';
    }
  };

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const text = ev.target?.result as string;
        const segments = JSON.parse(text);
        if (!Array.isArray(segments)) throw new Error("JSON must be an array of segments");
        
        // Ask background script to grab the active tab's source and submit a job
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs[0];
          if (activeTab && activeTab.id) {
            chrome.tabs.sendMessage(activeTab.id, {
              type: 'IMPORT_JOB_JSON',
              payload: { segments }
            }, (response) => {
              if (chrome.runtime.lastError || !response?.ok) {
                alert("Failed to load imported segments. Make sure a video is currently open and detected in the active tab.");
              } else {
                alert("Segments imported successfully! They now appear on the video timeline. You can adjust them and submit when ready.");
              }
            });
          }
        });
      } catch (err: any) {
        alert(`Failed to parse JSON: ${err.message}`);
      }
      e.target.value = ''; // reset
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="card">
        <div className="card-title">
          <span>Backend Processing Jobs</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', margin: 0, background: 'var(--bg-hover)' }}>
              Import JSON
              <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportJson} />
            </label>
            <button className="btn btn-secondary btn-sm" onClick={fetchJobs} disabled={loading}>
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
            </button>
          </div>
        </div>

        {error && (
          <div style={{ color: 'var(--accent-red)', fontSize: '11px', marginBottom: '8px' }}>
            {error}
          </div>
        )}

        {jobs.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#64748b', fontSize: '11px', padding: '16px' }}>
            No processing jobs found yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {jobs.map((job) => {
              const isFinished = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
              const needsSource = job.status === 'awaiting_source' || job.source_required;
              return (
                <div key={job.job_id} style={{ padding: '6px 8px', backgroundColor: 'var(--bg-primary)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontWeight: 600, fontSize: '11px', color: '#38bdf8', cursor: 'pointer' }} title="Copy ID" onClick={() => { navigator.clipboard.writeText(job.job_id); alert('Copied Job ID: ' + job.job_id); }}>
                        {job.job_id.substring(0, 8)}...
                      </span>
                    </div>
                    <span style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: getStatusColor(job.status) }}>
                      {job.status} {!isFinished && job.progress !== undefined && `(${job.progress}%)`}
                    </span>
                  </div>

                  {job.progress !== undefined && !isFinished && (
                    <div style={{ width: '100%', height: '4px', background: '#334155', borderRadius: '2px', margin: '4px 0', overflow: 'hidden' }}>
                      <div style={{ width: `${job.progress}%`, height: '100%', background: '#3b82f6', transition: 'width 0.3s' }} />
                    </div>
                  )}

                  {job.error && (
                    <div style={{ color: needsSource ? 'var(--accent-amber)' : 'var(--accent-red)', fontSize: '10px', marginTop: '2px', wordBreak: 'break-word' }}>
                      {needsSource ? 'Action required' : 'Error'}: {job.error}
                    </div>
                  )}

                  {needsSource && (
                    <label className="btn btn-primary btn-sm" style={{ marginTop: '7px', cursor: 'pointer', width: '100%', boxSizing: 'border-box' }}>
                      {uploadingJob === job.job_id ? 'Uploading source…' : 'Upload source and resume'}
                      <input
                        type="file"
                        accept="video/*,.mkv,.ts"
                        disabled={uploadingJob === job.job_id}
                        style={{ display: 'none' }}
                        onChange={(event) => {
                          void handleSourceUpload(job.job_id, event.target.files?.[0]);
                          event.target.value = '';
                        }}
                      />
                    </label>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                      {job.segments_count} cuts
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="btn btn-secondary btn-sm" style={{ padding: '2px 6px', fontSize: '10px' }} onClick={() => {
                        const jobData = job as any;
                        if (jobData.segments && jobData.segments.length > 0) {
                          const exportData = jobData.segments.map((s: any) => ({ start_seconds: s.start_seconds, end_seconds: s.end_seconds, categories: s.categories }));
                          const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a'); a.href = url; a.download = `${job.job_id}_export.json`; a.click(); URL.revokeObjectURL(url);
                        } else alert('No segments found for this job.');
                      }}>
                        Export
                      </button>
                      {!isFinished ? (
                        <button className="btn btn-secondary btn-sm" style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--accent-red)' }} onClick={() => handleCancelJob(job.job_id)}>Cancel</button>
                      ) : isFinished ? (
                        <button className="btn btn-secondary btn-sm" style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--accent-red)' }} onClick={() => handleDeleteJob(job.job_id)}>Delete</button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
