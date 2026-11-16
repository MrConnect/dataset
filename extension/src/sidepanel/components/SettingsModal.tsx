import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, FileDown, FileUp, KeyRound, Link2, PlugZap, Save } from 'lucide-react';
import { ExtensionSettings } from '../../types';
import { StorageService } from '../../services/storage';
import { ApiClient } from '../../services/api-client';
import { IconButton, IconFileButton, useNotify } from './ui';

interface SettingsModalProps {
  onClose?: () => void;
}

const SHORTCUTS: [string, string][] = [
  ['[', 'Mark start (edits the selected segment)'],
  [']', 'Mark end (edits the selected segment)'],
  ['Enter', 'Save segment / finish editing'],
  ['Esc', 'Clear markers / stop editing'],
  [', .', 'Previous / next frame'],
  ['Del', 'Delete the selected segment'],
  ['Ctrl+Z', 'Undo'],
  ['↑ ↓', 'Nudge a time field (Shift ×10)'],
];

export const SettingsModal: React.FC<SettingsModalProps> = () => {
  const notify = useNotify();
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    StorageService.getSettings().then(setSettings);
  }, []);

  if (!settings) {
    return <div className="empty-state">Loading…</div>;
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await StorageService.saveSettings(settings);
    notify('Settings saved');
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    // Save first so the test uses the values on screen.
    await StorageService.saveSettings(settings);
    setTestResult(await ApiClient.testConnection());
    setTesting(false);
  };

  const updatePreference = async (patch: Partial<ExtensionSettings>) => {
    const updated = { ...settings, ...patch };
    setSettings(updated);
    await StorageService.saveSettings(updated);
  };

  const handleExportSettings = () => {
    // The key is a credential: never write it into an exported file.
    const { api_key: _omitted, ...shareable } = settings;
    const url = URL.createObjectURL(new Blob([JSON.stringify(shareable, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `tagger_settings_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Settings exported (without the API key)');
  };

  const handleImportSettings = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        setSettings(await StorageService.saveSettings(parsed));
        notify('Settings imported');
      } catch {
        notify('That file is not a valid settings export', 'error');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="stack">
      <div className="section-head">
        <span className="section-title">Server connection</span>
        <div className="row">
          <IconButton icon={FileDown} label="Export settings (the API key is left out)" onClick={handleExportSettings} />
          <IconFileButton icon={FileUp} label="Import settings" accept=".json" onFile={handleImportSettings} />
        </div>
      </div>

      <form className="card stack-sm" onSubmit={handleSave}>
        <div className="field">
          <Link2 size={14} aria-hidden />
          <input
            type="text"
            className="input"
            value={settings.api_base_url}
            onChange={(e) => setSettings({ ...settings, api_base_url: e.target.value })}
            placeholder="https://your-server.example.com"
            aria-label="Server URL"
            required
          />
        </div>

        <div className="field">
          <KeyRound size={14} aria-hidden />
          <input
            type={showKey ? 'text' : 'password'}
            className="input"
            value={settings.api_key}
            onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
            placeholder="Client key from the dashboard (vdt_…)"
            aria-label="API key"
            autoComplete="off"
          />
          <IconButton
            icon={showKey ? EyeOff : Eye}
            label={showKey ? 'Hide key' : 'Show key'}
            variant="ghost"
            onClick={() => setShowKey(!showKey)}
          />
        </div>

        <div className="row end">
          <IconButton
            icon={PlugZap}
            label="Save and test connection"
            spinning={testing}
            disabled={testing}
            onClick={() => void handleTestConnection()}
          />
          <IconButton type="submit" icon={Save} label="Save settings" variant="primary" />
        </div>

        {testResult && (
          <div className={`banner ${testResult.ok ? 'ok' : 'bad'}`}>
            {testResult.ok ? <CheckCircle2 size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
            <span>{testResult.message}</span>
          </div>
        )}
      </form>

      <div className="section-head">
        <span className="section-title">Behaviour</span>
      </div>
      <div className="card stack-sm">
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.auto_detection_enabled}
            onChange={(e) => void updatePreference({ auto_detection_enabled: e.target.checked })}
          />
          <span className="toggle-track" />
          <span>Detect videos automatically</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.show_floating_overlay}
            onChange={(e) => void updatePreference({ show_floating_overlay: e.target.checked })}
          />
          <span className="toggle-track" />
          <span>Show tagging controls on the player</span>
        </label>
      </div>

      <div className="section-head">
        <span className="section-title">Shortcuts on the player</span>
      </div>
      <div className="card shortcut-grid">
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys}>
            <kbd>{keys}</kbd>
            <span>{action}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
