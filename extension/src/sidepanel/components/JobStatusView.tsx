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

  const getStatusColor = (status: JobStatus) => {
    switch (status) {
      case 'completed':
        return 'var(--accent-green)';
      case 'failed':
        return 'var(--accent-red)';
      case 'cancelled':
        return '#64748b';
      case 'downloading':
      case 'processing':
        return '#38bdf8';
      default:
        return 'var(--accent-amber)';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="card">
        <div className="card-title">
          <span>Backend Processing Jobs</span>
          <button className="btn btn-secondary btn-sm" onClick={fetchJobs} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {error && (
          <div style={{ color: 'var(--accent-red)', fontSize: '11px', marginBottom: '8px' }}>
            {error}
          </div>
        )}

        {jobs.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#64748b', fontSize: '11px', padding: '16px' }}>
            No processing jobs found yet. Submit segments from the Tagging tab.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {jobs.map((job) => {
              const isFinished = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';

              return (
                <div
                  key={job.job_id}
                  style={{
                    padding: '8px 10px',
                    backgroundColor: 'var(--bg-primary)',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span 
                      style={{ fontWeight: 600, fontSize: '12px', color: '#38bdf8', cursor: 'pointer' }}
                      title="Click to copy Job ID"
                      onClick={() => {
                        navigator.clipboard.writeText(job.job_id);
                        alert('Copied Job ID: ' + job.job_id);
                      }}
                    >
                      {job.job_id} 📋
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        color: getStatusColor(job.status),
                      }}
                    >
                      ● {job.status}
                    </span>
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                    <span>Segments: {job.segments_count}</span>
                    {job.created_at && <span>{new Date(job.created_at).toLocaleTimeString()}</span>}
                  </div>

                  {job.progress !== undefined && !isFinished && (
                    <div style={{ width: '100%', height: '4px', background: '#334155', borderRadius: '2px', margin: '6px 0', overflow: 'hidden' }}>
                      <div style={{ width: `${job.progress}%`, height: '100%', background: '#3b82f6', transition: 'width 0.3s' }} />
                    </div>
                  )}

                  {job.error && (
                    <div style={{ color: 'var(--accent-red)', fontSize: '10px', marginTop: '4px', wordBreak: 'break-all' }}>
                      Error: {job.error}
                    </div>
                  )}

                  {!isFinished && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleCancelJob(job.job_id)}
                        style={{ color: 'var(--accent-red)' }}
                      >
                        Cancel Job
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
