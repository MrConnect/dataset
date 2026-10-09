import React from 'react';
import { DetectedSource, VideoQuality } from '../../types';

interface QualitySelectorProps {
  source: DetectedSource;
  selectedQuality: VideoQuality | null;
  onSelectQuality: (quality: VideoQuality) => void;
}

export const QualitySelector: React.FC<QualitySelectorProps> = ({
  source,
  selectedQuality,
  onSelectQuality,
}) => {
  if (!source.qualities || source.qualities.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Selected Quality</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
          No quality metadata extracted yet. Defaulting to standard stream.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Quality & Resolution</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {source.qualities.map((q, idx) => {
          const isSelected =
            selectedQuality &&
            (selectedQuality.variant_url === q.variant_url ||
              selectedQuality.representation_id === q.representation_id ||
              selectedQuality.height === q.height);

          return (
            <label
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: '6px',
                backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.2)' : 'var(--bg-primary)',
                border: isSelected ? '1px solid var(--accent-blue)' : '1px solid var(--border-color)',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  name="video_quality"
                  checked={!!isSelected}
                  onChange={() => onSelectQuality(q)}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontWeight: 500, fontSize: '12px' }}>
                  {q.label || (q.height ? `${q.height}p` : 'Auto')}
                </span>
              </div>

              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                {q.bandwidth ? `${Math.round(q.bandwidth / 1000)} kbps` : ''}
                {q.codecs ? ` • ${q.codecs}` : ''}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
};
