import React, { useState, useEffect } from 'react';
import { Category } from '../types';
import { StorageService } from '../services/storage';
import { ApiClient } from '../services/api-client';
import { CategoryManager } from './components/CategoryManager';
import { JobStatusView } from './components/JobStatusView';
import { SettingsModal } from './components/SettingsModal';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'categories' | 'jobs' | 'settings'>('jobs');
  const [categories, setCategories] = useState<Category[]>([]);
  const [labelSyncState, setLabelSyncState] = useState<'syncing' | 'synced' | 'offline'>('syncing');

  const mergeCategories = (remote: Category[], local: Category[]): Category[] => {
    const merged = new Map(remote.map((category) => [category.id, category]));
    local.forEach((category) => merged.set(category.id, category));
    return Array.from(merged.values());
  };

  const syncLabels = async () => {
    try {
      setLabelSyncState('syncing');
      const localCategories = await StorageService.getCategories();
      const remoteCategories = await ApiClient.listCategories();
      const initialized = await StorageService.isCategorySyncInitialized();
      const effectiveCategories = initialized
        ? remoteCategories
        : await ApiClient.syncCategories(mergeCategories(remoteCategories, localCategories));

      await StorageService.saveCategories(effectiveCategories);
      await StorageService.markCategorySyncInitialized();
      setCategories(effectiveCategories);
      setLabelSyncState('synced');
    } catch (err) {
      console.warn('Failed to sync labels; keeping the local copy', err);
      setCategories(await StorageService.getCategories());
      setLabelSyncState('offline');
    }
  };

  useEffect(() => {
    void syncLabels();
    const interval = window.setInterval(() => void syncLabels(), 10000);
    const handleChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.tagger_categories?.newValue) {
        setCategories(changes.tagger_categories.newValue as Category[]);
      }
      if (changes.tagger_settings) void syncLabels();
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => {
      window.clearInterval(interval);
      chrome.storage.onChanged.removeListener(handleChange);
    };
  }, []);

  const handleSaveCategories = async (updatedCategories: Category[]) => {
    setCategories(updatedCategories);
    await StorageService.saveCategories(updatedCategories);
    setLabelSyncState('syncing');
    try {
      const updatedIds = new Set(updatedCategories.map((category) => category.id));
      const removedIds = categories.filter((category) => !updatedIds.has(category.id)).map((category) => category.id);
      await Promise.all(removedIds.map((categoryId) => ApiClient.deleteCategory(categoryId)));
      const authoritative = await ApiClient.syncCategories(updatedCategories);
      await StorageService.saveCategories(authoritative);
      await StorageService.markCategorySyncInitialized();
      setCategories(authoritative);
      setLabelSyncState('synced');
    } catch (err) {
      console.warn('Labels were saved locally but server sync failed', err);
      setLabelSyncState('offline');
    }
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
          <CategoryManager
            categories={categories}
            onSaveCategories={handleSaveCategories}
            syncState={labelSyncState}
            onSync={() => syncLabels()}
          />
        )}

        {activeTab === 'jobs' && <JobStatusView lastSubmittedJobId={null} />}

        {activeTab === 'settings' && <SettingsModal />}
      </div>
    </div>
  );
};
