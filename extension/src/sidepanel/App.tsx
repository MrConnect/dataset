import React, { useState, useEffect } from 'react';
import { Film, ListChecks, Settings, Tags, type LucideIcon } from 'lucide-react';
import { Category } from '../types';
import { StorageService } from '../services/storage';
import { ApiClient } from '../services/api-client';
import { CategoryManager } from './components/CategoryManager';
import { JobStatusView } from './components/JobStatusView';
import { SettingsModal } from './components/SettingsModal';
import { NotifyProvider } from './components/ui';

type Tab = 'jobs' | 'categories' | 'settings';
type SyncState = 'syncing' | 'synced' | 'offline';

const SYNC_LABEL: Record<SyncState, string> = {
  synced: 'Connected to server',
  syncing: 'Syncing…',
  offline: 'Server unreachable — working locally',
};

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('jobs');
  const [categories, setCategories] = useState<Category[]>([]);
  const [labelSyncState, setLabelSyncState] = useState<SyncState>('syncing');

  const syncLabels = async () => {
    try {
      setLabelSyncState('syncing');
      const effectiveCategories = await ApiClient.syncStoredCategories();
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

  const tabs: { id: Tab; label: string; icon: LucideIcon; count?: number }[] = [
    { id: 'jobs', label: 'Jobs', icon: ListChecks },
    { id: 'categories', label: 'Labels', icon: Tags, count: categories.length },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <NotifyProvider>
      <div className="app-container">
        <header className="header">
          <div className="brand">
            <span className="brand-mark">
              <Film size={14} aria-hidden />
            </span>
            <span className="brand-name">Video Segment Tagger</span>
          </div>
          <span className={`sync-dot ${labelSyncState}`} title={SYNC_LABEL[labelSyncState]} aria-label={SYNC_LABEL[labelSyncState]} />
        </header>

        <nav className="nav-tabs">
          {tabs.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              className={`nav-tab-btn ${activeTab === id ? 'active' : ''}`}
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? 'page' : undefined}
            >
              <Icon size={15} aria-hidden />
              <span>{label}</span>
              {count !== undefined && count > 0 && <em>{count}</em>}
            </button>
          ))}
        </nav>

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
    </NotifyProvider>
  );
};
