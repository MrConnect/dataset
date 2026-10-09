import React, { useState } from 'react';
import { Category, Segment } from '../../types';
import { formatTime } from '../../utils/time';
import { generateId } from '../../utils/uuid';

interface TimelineTaggerProps {
  currentTime: number;
  duration: number;
  segments: Segment[];
  categories: Category[];
  onAddSegment: (segment: Segment) => void;
  onUpdateSegment: (segment: Segment) => void;
  onDeleteSegment: (segmentId: string) => void;
  onSeek: (seconds: number) => void;
}

export const TimelineTagger: React.FC<TimelineTaggerProps> = ({
  currentTime,
  duration,
  segments,
  categories,
  onAddSegment,
  onUpdateSegment,
  onDeleteSegment,
  onSeek,
}) => {
  const [startSeconds, setStartSeconds] = useState<number | ''>('');
  const [endSeconds, setEndSeconds] = useState<number | ''>('');
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(
    categories.length > 0 ? [categories[0].id] : []
  );
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);

  const effectiveDuration = duration > 0 ? duration : Math.max(100, currentTime + 10);

  const handleMarkStart = () => {
    setStartSeconds(Math.round(currentTime * 100) / 100);
  };

  const handleMarkEnd = () => {
    setEndSeconds(Math.round(currentTime * 100) / 100);
  };

  const handleToggleCategory = (catId: string) => {
    setSelectedCategoryIds((prev) =>
      prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId]
    );
  };

  const handleSaveSegment = () => {
    const s = typeof startSeconds === 'number' ? startSeconds : 0;
    const e = typeof endSeconds === 'number' ? endSeconds : currentTime;

    if (e <= s) {
      alert('End time must be greater than Start time.');
      return;
    }

    if (selectedCategoryIds.length === 0) {
      alert('Please select at least one category for this segment.');
      return;
    }

    if (editingSegmentId) {
      const existing = segments.find((seg) => seg.id === editingSegmentId);
      if (existing) {
        onUpdateSegment({
          ...existing,
          start_seconds: s,
          end_seconds: e,
          categories: selectedCategoryIds,
        });
      }
      setEditingSegmentId(null);
    } else {
      const newSeg: Segment = {
        id: generateId('seg'),
        start_seconds: s,
        end_seconds: e,
        categories: selectedCategoryIds,
      };
      onAddSegment(newSeg);
    }

    setStartSeconds('');
    setEndSeconds('');
  };

  const handleEdit = (seg: Segment) => {
    setEditingSegmentId(seg.id);
    setStartSeconds(seg.start_seconds);
    setEndSeconds(seg.end_seconds);
    setSelectedCategoryIds(seg.categories);
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    const targetTime = fraction * effectiveDuration;
    onSeek(targetTime);
  };

  const playheadPercent = Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100));

  return (
    <div className="card">
      <div className="card-title">
        <span>Timeline & Segment Tagger</span>
        <span style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      {/* Visual Timeline Bar */}
      <div className="timeline-bar" onClick={handleTimelineClick} title="Click to seek">
        <div className="timeline-progress" style={{ width: `${playheadPercent}%` }} />
        <div className="timeline-playhead" style={{ left: `${playheadPercent}%` }} />

        {/* Render Segment Overlays on Timeline */}
        {segments.map((seg) => {
          const segLeft = Math.max(0, (seg.start_seconds / effectiveDuration) * 100);
          const segWidth = Math.max(
            0.5,
            ((seg.end_seconds - seg.start_seconds) / effectiveDuration) * 100
          );
          const primaryCat = categories.find((c) => c.id === seg.categories[0]);
          const color = primaryCat?.color || '#3b82f6';

          return (
            <div
              key={seg.id}
              className="timeline-segment-block"
              style={{
                left: `${segLeft}%`,
                width: `${segWidth}%`,
                backgroundColor: color,
              }}
              title={`${formatTime(seg.start_seconds)} - ${formatTime(seg.end_seconds)} (${seg.categories.join(', ')})`}
            />
          );
        })}
      </div>

      {/* Segment Input & Action Controls */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>
            Start Time (s)
          </label>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type="number"
              step="0.1"
              className="input"
              value={startSeconds}
              onChange={(e) => setStartSeconds(e.target.value === '' ? '' : parseFloat(e.target.value))}
              placeholder="0.0"
            />
            <button className="btn btn-secondary btn-sm" onClick={handleMarkStart} title="Mark Start [ [ ]">
              [ Set
            </button>
          </div>
        </div>

        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>
            End Time (s)
          </label>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type="number"
              step="0.1"
              className="input"
              value={endSeconds}
              onChange={(e) => setEndSeconds(e.target.value === '' ? '' : parseFloat(e.target.value))}
              placeholder="0.0"
            />
            <button className="btn btn-secondary btn-sm" onClick={handleMarkEnd} title="Mark End [ ] ]">
              ] Set
            </button>
          </div>
        </div>
      </div>

      {/* Category Pills Selector */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
          Assign Categories:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {categories.map((cat) => {
            const isSelected = selectedCategoryIds.includes(cat.id);
            return (
              <button
                key={cat.id}
                onClick={() => handleToggleCategory(cat.id)}
                style={{
                  border: isSelected ? `1px solid ${cat.color}` : '1px solid var(--border-color)',
                  backgroundColor: isSelected ? cat.color : 'var(--bg-primary)',
                  color: isSelected ? '#fff' : 'var(--text-primary)',
                  borderRadius: '12px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  transition: 'all 0.15s ease',
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: isSelected ? '#fff' : cat.color,
                  }}
                />
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Save Button */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
        <button
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={handleSaveSegment}
          disabled={startSeconds === '' || endSeconds === ''}
        >
          {editingSegmentId ? 'Update Segment' : 'Add Segment (Ctrl+Enter)'}
        </button>
        {editingSegmentId && (
          <button
            className="btn btn-secondary"
            onClick={() => {
              setEditingSegmentId(null);
              setStartSeconds('');
              setEndSeconds('');
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {/* Segments List */}
      <div>
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
          Tagged Segments ({segments.length})
        </div>

        {segments.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#64748b', fontSize: '11px', padding: '12px' }}>
            No segments added yet. Set Start and End times above or press `[` and `]`.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {segments.map((seg, idx) => {
              const segDur = Math.max(0, seg.end_seconds - seg.start_seconds).toFixed(2);

              return (
                <div
                  key={seg.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    backgroundColor: 'var(--bg-primary)',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div
                    onClick={() => onSeek(seg.start_seconds)}
                    style={{ cursor: 'pointer', flex: 1 }}
                    title="Click to jump to segment start"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontWeight: 600, color: '#38bdf8', fontSize: '12px' }}>
                        #{idx + 1}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                        {formatTime(seg.start_seconds)} → {formatTime(seg.end_seconds)}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                        ({segDur}s)
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '3px' }}>
                      {seg.categories.map((cId) => {
                        const cat = categories.find((c) => c.id === cId);
                        return (
                          <span
                            key={cId}
                            style={{
                              backgroundColor: cat ? `${cat.color}22` : '#334155',
                              border: `1px solid ${cat ? cat.color : '#475569'}`,
                              color: cat ? cat.color : '#e2e8f0',
                              padding: '1px 5px',
                              borderRadius: '4px',
                              fontSize: '10px',
                            }}
                          >
                            {cat ? cat.name : cId}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleEdit(seg)}
                      title="Edit"
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => onDeleteSegment(seg.id)}
                      title="Delete"
                    >
                      Del
                    </button>
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
