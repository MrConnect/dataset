import React, { useState } from 'react';
import { DetectedSource } from '../../types';

interface VideoListProps {
  sources: DetectedSource[];
  activeSourceId: string | null;
  onSelectSource: (source: DetectedSource) => void;
  onRefresh: () => void;
  onAddManualUrl?: (url: string) => void;
}

export const VideoList: React.FC<VideoListProps> = ({
  sources,
  activeSourceId,
  onSelectSource,
  onRefresh,
  onAddManualUrl,
}) => {
  const [showAddInput, setShowAddInput] = useState(false);
  const [manualUrl, setManualUrl] = useState('');

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualUrl.trim() && onAddManualUrl) {
      onAddManualUrl(manualUrl.trim());
      setManualUrl('');
      setShowAddInput(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">
        <span>Detected Videos ({sources.length})</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowAddInput(!showAddInput)}
            title="Paste or enter a stream URL manually"
          >
            {showAddInput ? 'Cancel' : '+ URL'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onRefresh} title="Scan page for videos">
            Scan
          </button>
        </div>
      </div>

      {showAddInput && (
        <form onSubmit={handleAddSubmit} style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
          <input
            type="text"
            className="input"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="Paste .m3u8, .mp4, or stream URL..."
            style={{ flex: 1, fontSize: '11px' }}
            autoFocus
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Add
          </button>
        </form>
      )}

      {sources.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '16px 8px' }}>
          <div style={{ color: 'var(--text-secondary)', marginBottom: '6px', fontSize: '12px' }}>
            No video stream detected yet.
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', lineHeight: 1.5, marginBottom: '10px' }}>
            ▶ <strong>Click Play</strong> on the video player in the page to trigger stream loading.
          </div>
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
            <button className="btn btn-secondary btn-sm" onClick={onRefresh}>
              ↻ Refresh Detection
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddInput(true)}>
              + Paste Stream URL
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {sources.map((src) => {
            const isSelected = src.id === activeSourceId;
            const badgeClass =
              src.type === 'hls' ? 'badge-hls' : src.type === 'dash' ? 'badge-dash' : 'badge-mp4';

            return (
              <div
                key={src.id}
                onClick={() => onSelectSource(src)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-primary)',
                  border: isSelected ? '1px solid var(--accent-blue)' : '1px solid var(--border-color)',
                  cursor: 'pointer',
                  transition: 'border 0.2s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span className={`badge ${badgeClass}`}>{src.type}</span>
                  <span
                    style={{
                      fontSize: '11px',
                      color:
                        src.status === 'available'
                          ? 'var(--accent-green)'
                          : src.status === 'requires_validation'
                          ? 'var(--accent-amber)'
                          : 'var(--accent-red)',
                    }}
                  >
                    {src.status === 'available'
                      ? 'Available'
                      : src.status === 'requires_validation'
                      ? 'Requires Validation'
                      : 'Unsupported'}
                  </span>
                </div>

                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: isSelected ? '#93c5fd' : 'var(--text-primary)',
                  }}
                  title={src.media_url}
                >
                  {src.title || src.media_url.split('/').pop()?.split('?')[0] || 'Video Stream'}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  <span>
                    {src.qualities.length} {src.qualities.length === 1 ? 'quality' : 'qualities'} available
                  </span>
                  {src.duration_seconds ? <span>{Math.round(src.duration_seconds)}s</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
