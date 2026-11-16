import React, { useState } from 'react';
import { Check, Cloud, CloudOff, FileDown, FileUp, Pencil, Plus, RefreshCw, Tags, Trash2, X } from 'lucide-react';
import { Category } from '../../types';
import { generateId } from '../../utils/uuid';
import { ConfirmButton, IconButton, IconFileButton, useNotify } from './ui';

interface CategoryManagerProps {
  categories: Category[];
  onSaveCategories: (categories: Category[]) => Promise<void>;
  syncState: 'syncing' | 'synced' | 'offline';
  onSync: () => Promise<void>;
}

const DEFAULT_COLOR = '#22C55E';
const PALETTE = ['#22C55E', '#3B82F6', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4', '#EC4899', '#84CC16'];

export const CategoryManager: React.FC<CategoryManagerProps> = ({
  categories,
  onSaveCategories,
  syncState,
  onSync,
}) => {
  const notify = useNotify();
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [description, setDescription] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [editingCatId, setEditingCatId] = useState<string | null>(null);

  const resetForm = () => {
    setEditingCatId(null);
    setName('');
    setDescription('');
    setShortcut('');
    setColor(DEFAULT_COLOR);
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const fields = {
      name: name.trim(),
      color,
      description: description.trim() || undefined,
      shortcut: shortcut.trim() || undefined,
    };

    if (editingCatId) {
      await onSaveCategories(categories.map((cat) => (cat.id === editingCatId ? { ...cat, ...fields } : cat)));
    } else {
      await onSaveCategories([...categories, { id: generateId('cat'), ...fields }]);
    }
    resetForm();
  };

  const handleEdit = (cat: Category) => {
    setEditingCatId(cat.id);
    setName(cat.name);
    setColor(cat.color);
    setDescription(cat.description || '');
    setShortcut(cat.shortcut || '');
  };

  const handleDelete = async (catId: string) => {
    if (editingCatId === catId) resetForm();
    await onSaveCategories(categories.filter((c) => c.id !== catId));
  };

  const handleExport = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(categories, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `labels_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (!Array.isArray(parsed)) throw new Error('expected a list of labels');
        const valid: Category[] = parsed.map((item: any) => ({
          id: String(item.id || generateId('cat')),
          name: String(item.name || 'Unnamed'),
          color: String(item.color || '#3b82f6'),
          description: item.description ? String(item.description) : undefined,
          shortcut: item.shortcut ? String(item.shortcut) : undefined,
        }));
        await onSaveCategories(valid);
        notify(`Imported ${valid.length} labels`);
      } catch (err: any) {
        notify(`Could not import: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  };

  const SyncIcon = syncState === 'offline' ? CloudOff : Cloud;

  return (
    <div className="stack">
      <div className="section-head">
        <span className="section-title">
          <SyncIcon size={13} aria-hidden className={syncState === 'offline' ? 'text-bad' : 'text-muted'} />
          {syncState === 'synced' ? 'Synced with server' : syncState === 'syncing' ? 'Syncing…' : 'Saved locally only'}
        </span>
        <div className="row">
          <IconButton icon={FileDown} label="Export labels as JSON" onClick={handleExport} disabled={!categories.length} />
          <IconFileButton icon={FileUp} label="Import labels from JSON (replaces the list)" accept=".json" onFile={handleImport} />
          <IconButton
            icon={RefreshCw}
            label="Sync labels now"
            spinning={syncState === 'syncing'}
            disabled={syncState === 'syncing'}
            onClick={() => void onSync()}
          />
        </div>
      </div>

      <form className="card label-form" onSubmit={handleCreateOrUpdate}>
        <div className="label-form-main">
          <label className="color-swatch" style={{ background: color }} title="Label colour">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Label colour" />
          </label>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={editingCatId ? 'Label name' : 'New label, e.g. Person walking'}
            aria-label="Label name"
            required
          />
          <input
            type="text"
            maxLength={1}
            className="input key-input"
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            placeholder="⌨"
            title="Keyboard shortcut (one key, optional)"
            aria-label="Keyboard shortcut"
          />
          {editingCatId && <IconButton icon={X} label="Cancel editing" onClick={resetForm} />}
          <IconButton
            type="submit"
            icon={editingCatId ? Check : Plus}
            label={editingCatId ? 'Save changes' : 'Add label'}
            variant="primary"
            disabled={!name.trim()}
          />
        </div>

        <div className="palette">
          {PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={swatch.toLowerCase() === color.toLowerCase() ? 'active' : ''}
              style={{ background: swatch }}
              title={swatch}
              aria-label={`Use colour ${swatch}`}
              onClick={() => setColor(swatch)}
            />
          ))}
        </div>

        <input
          type="text"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Annotation guideline (optional)"
          aria-label="Description"
        />
      </form>

      {categories.length === 0 ? (
        <div className="empty-state">
          <Tags size={26} aria-hidden />
          <strong>No labels yet</strong>
          <span>Add the labels you will tag segments with.</span>
        </div>
      ) : (
        <div className="label-list">
          {categories.map((cat) => (
            <div key={cat.id} className={`label-row ${editingCatId === cat.id ? 'editing' : ''}`}>
              <span className="label-dot" style={{ background: cat.color }} />
              <div className="label-text">
                <strong>
                  {cat.name}
                  {cat.shortcut && <kbd>{cat.shortcut}</kbd>}
                </strong>
                {cat.description && <small title={cat.description}>{cat.description}</small>}
              </div>
              <IconButton icon={Pencil} label={`Edit ${cat.name}`} variant="ghost" onClick={() => handleEdit(cat)} />
              <ConfirmButton
                icon={Trash2}
                label={`Delete ${cat.name}`}
                confirmLabel="Click again to delete this label"
                onConfirm={() => void handleDelete(cat.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
