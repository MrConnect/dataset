import React, { useState } from 'react';
import { Category } from '../../types';
import { generateId } from '../../utils/uuid';

interface CategoryManagerProps {
  categories: Category[];
  onSaveCategories: (categories: Category[]) => void;
}

export const CategoryManager: React.FC<CategoryManagerProps> = ({
  categories,
  onSaveCategories,
}) => {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#22C55E');
  const [description, setDescription] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [editingCatId, setEditingCatId] = useState<string | null>(null);

  const handleCreateOrUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (editingCatId) {
      const updated = categories.map((cat) =>
        cat.id === editingCatId
          ? {
              ...cat,
              name: name.trim(),
              color,
              description: description.trim() || undefined,
              shortcut: shortcut.trim() || undefined,
            }
          : cat
      );
      onSaveCategories(updated);
      setEditingCatId(null);
    } else {
      const newCat: Category = {
        id: generateId('cat'),
        name: name.trim(),
        color,
        description: description.trim() || undefined,
        shortcut: shortcut.trim() || undefined,
      };
      onSaveCategories([...categories, newCat]);
    }

    setName('');
    setDescription('');
    setShortcut('');
    setColor('#22C55E');
  };

  const handleEdit = (cat: Category) => {
    setEditingCatId(cat.id);
    setName(cat.name);
    setColor(cat.color);
    setDescription(cat.description || '');
    setShortcut(cat.shortcut || '');
  };

  const handleDelete = (catId: string) => {
    if (confirm('Are you sure you want to delete this category?')) {
      onSaveCategories(categories.filter((c) => c.id !== catId));
    }
  };

  const handleExport = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(categories, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `preset_categories_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (Array.isArray(parsed)) {
          // Validate structure
          const valid = parsed.map((item: any) => ({
            id: String(item.id || generateId('cat')),
            name: String(item.name || 'Unnamed'),
            color: String(item.color || '#3b82f6'),
            description: item.description ? String(item.description) : undefined,
            shortcut: item.shortcut ? String(item.shortcut) : undefined,
          }));
          onSaveCategories(valid);
          alert(`Successfully imported ${valid.length} categories.`);
        }
      } catch (err) {
        alert('Failed to parse categories JSON file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Category Editor Card */}
      <div className="card">
        <div className="card-title">
          <span>{editingCatId ? 'Edit Category' : 'New Preset Category'}</span>
          {editingCatId && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setEditingCatId(null);
                setName('');
                setDescription('');
                setShortcut('');
              }}
            >
              Cancel Edit
            </button>
          )}
        </div>

        <form onSubmit={handleCreateOrUpdate} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Category Name *</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Person Walking"
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Badge Color</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  style={{
                    border: 'none',
                    width: '32px',
                    height: '32px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    backgroundColor: 'transparent',
                  }}
                />
                <input
                  type="text"
                  className="input"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Shortcut (Optional)</label>
              <input
                type="text"
                maxLength={1}
                className="input"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                placeholder="e.g. w"
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Description (Optional)</label>
            <input
              type="text"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief annotation guideline..."
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ marginTop: '4px' }}>
            {editingCatId ? 'Save Changes' : 'Create Category'}
          </button>
        </form>
      </div>

      {/* Preset Categories List */}
      <div className="card">
        <div className="card-title">
          <span>Preset Categories ({categories.length})</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button className="btn btn-secondary btn-sm" onClick={handleExport} title="Export to JSON">
              Export
            </button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }} title="Import from JSON">
              Import
              <input type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {categories.map((cat) => (
            <div
              key={cat.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                backgroundColor: 'var(--bg-primary)',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '50%',
                    backgroundColor: cat.color,
                  }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: '12px' }}>
                    {cat.name}
                    {cat.shortcut && (
                      <span
                        style={{
                          marginLeft: '6px',
                          fontSize: '10px',
                          padding: '1px 4px',
                          backgroundColor: 'var(--bg-tertiary)',
                          borderRadius: '3px',
                          color: '#38bdf8',
                        }}
                      >
                        [{cat.shortcut}]
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>
                    ID: {cat.id} {cat.description ? `• ${cat.description}` : ''}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleEdit(cat)}>
                  Edit
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(cat.id)}>
                  Del
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
