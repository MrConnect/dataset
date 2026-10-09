import React, { useState, useEffect } from 'react';
import { Category } from '../types';
import { StorageService } from '../services/storage';
import { CategoryManager } from './components/CategoryManager';
import { JobStatusView } from './components/JobStatusView';
import { SettingsModal } from './components/SettingsModal';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'categories' | 'jobs' | 'settings'>('jobs');
  const [categories, setCategories] = useState<Category[]>([]);
  
  const refreshTabData = async () => {
    try {
      const dbCategories = await StorageService.getCategories();
      setCategories(dbCategories);
    } catch (err) {
      console.warn('Failed to refresh data', err);
    }
  };

  useEffect(() => {
    refreshTabData();
    const interval = setInterval(() => {
      refreshTabData();
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const handleSaveCategories = async (updatedCategories: Category[]) => {
    setCategories(updatedCategories);
    await StorageService.saveCategories(updatedCategories);
  };

  return (
    <div className="app-container">
      {/* Header */}
      <div className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '4px',
              background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: '11px',
              color: '#fff',
            }}
          >
            V
          </div>
          <span style={{ fontWeight: 600, fontSize: '13px' }}>Video Segment Tagger</span>
        </div>
        <span
          style={{
            fontSize: '10px',
            background: 'rgba(59, 130, 246, 0.2)',
            color: '#93c5fd',
            padding: '2px 6px',
            borderRadius: '4px',
          }}
        >
          CVAT Ready
        </span>
      </div>

      {/* Tabs */}
      <div className="nav-tabs">
        <button
          className={`nav-tab-btn ${activeTab === 'jobs' ? 'active' : ''}`}
          onClick={() => setActiveTab('jobs')}
        >
          Jobs (Status)
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'categories' ? 'active' : ''}`}
          onClick={() => setActiveTab('categories')}
        >
          Labels ({categories.length})
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </div>

      {/* Content Body */}
      <div className="content-body">
        {activeTab === 'categories' && (
          <CategoryManager categories={categories} onSaveCategories={handleSaveCategories} />
        )}

        {activeTab === 'jobs' && <JobStatusView lastSubmittedJobId={null} />}

        {activeTab === 'settings' && <SettingsModal />}
      </div>
    </div>
  );
};
