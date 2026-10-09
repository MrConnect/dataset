import React, { useEffect, useState } from 'react';
import { ExtensionSettings } from '../../types';
import { StorageService } from '../../services/storage';
import { ApiClient } from '../../services/api-client';

interface SettingsModalProps {
  onClose?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = () => {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [savedMessage, setSavedMessage] = useState(false);

  useEffect(() => {
    StorageService.getSettings().then(setSettings);
  }, []);

  if (!settings) {
    return <div style={{ padding: '16px' }}>Loading settings...</div>;
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await StorageService.saveSettings(settings);
    setSavedMessage(true);
    setTimeout(() => setSavedMessage(false), 2500);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    // Save first so test uses current values
    await StorageService.saveSettings(settings);
    const res = await ApiClient.testConnection();
    setTestResult(res);
    setTesting(false);
  };

  const handleExportSettings = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(settings, null, 2));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = `tagger_settings_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleImportSettings = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const updated = await StorageService.saveSettings(parsed);
        setSettings(updated);
        alert('Settings imported successfully.');
      } catch {
        alert('Invalid settings file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="card">
        <div className="card-title">
          <span>Backend & Connection</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button className="btn btn-secondary btn-sm" onClick={handleExportSettings}>
              Export
            </button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              Import
              <input type="file" accept=".json" onChange={handleImportSettings} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Backend API Base URL</label>
            <input
              type="text"
              className="input"
              value={settings.api_base_url}
              onChange={(e) => setSettings({ ...settings, api_base_url: e.target.value })}
              placeholder="http://localhost:8000"
              required
            />
          </div>

          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>API Key (X-API-Key Header)</label>
            <input
              type="password"
              className="input"
              value={settings.api_key}
              onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
              placeholder="Enter server API key"
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={testing}
              style={{ flex: 1 }}
            >
              {testing ? 'Testing...' : 'Test API Connection'}
            </button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
              Save Settings
            </button>
          </div>

          {testResult && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                backgroundColor: testResult.ok ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: testResult.ok ? '1px solid var(--accent-green)' : '1px solid var(--accent-red)',
                color: testResult.ok ? 'var(--accent-green)' : 'var(--accent-red)',
              }}
            >
              {testResult.ok ? '[OK] ' : '[Error] '} {testResult.message}
            </div>
          )}

          {savedMessage && (
            <div style={{ color: 'var(--accent-green)', fontSize: '11px', textAlign: 'center' }}>
              Settings saved successfully
            </div>
          )}
        </form>
      </div>

      <div className="card">
        <div className="card-title">Preferences & Shortcuts</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.auto_detection_enabled}
              onChange={(e) => setSettings({ ...settings, auto_detection_enabled: e.target.checked })}
            />
            Auto Detection Enabled
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.show_floating_overlay}
              onChange={(e) => setSettings({ ...settings, show_floating_overlay: e.target.checked })}
            />
            Show Floating Overlay on Player
          </label>

          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '8px', marginTop: '4px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
              Keyboard Shortcuts Reference:
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px', color: '#94a3b8' }}>
              <div><kbd style={{ background: '#334155', padding: '1px 4px', borderRadius: '3px' }}>[</kbd> Mark Start</div>
              <div><kbd style={{ background: '#334155', padding: '1px 4px', borderRadius: '3px' }}>]</kbd> Mark End</div>
              <div><kbd style={{ background: '#334155', padding: '1px 4px', borderRadius: '3px' }}>Ctrl+Enter</kbd> Save</div>
              <div><kbd style={{ background: '#334155', padding: '1px 4px', borderRadius: '3px' }}>Esc</kbd> Cancel</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
