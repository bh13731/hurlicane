import React, { useEffect, useState } from 'react';
import type { Template } from '@shared/types';

interface TemplateManagerProps {
  onClose: () => void;
}

export function TemplateManager({ onClose }: TemplateManagerProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  function startCreate() {
    setEditing(null);
    setName('');
    setContent('');
    setWorkDir('');
    setModel('');
    setCreating(true);
  }

  function startEdit(t: Template) {
    setCreating(false);
    setEditing(t);
    setName(t.name);
    setContent(t.content);
    setWorkDir(t.work_dir ?? '');
    setModel(t.model ?? '');
  }

  function cancelForm() {
    setCreating(false);
    setEditing(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        const res = await fetch(`/api/templates/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), content: content.trim(), workDir: workDir.trim() || null, model: model.trim() || null }),
        });
        const updated: Template = await res.json();
        setTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
      } else {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), content: content.trim(), workDir: workDir.trim() || undefined, model: model.trim() || undefined }),
        });
        const created: Template = await res.json();
        setTemplates(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      cancelForm();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: Template) {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    await fetch(`/api/templates/${t.id}`, { method: 'DELETE' });
    setTemplates(prev => prev.filter(x => x.id !== t.id));
    if (editing?.id === t.id) cancelForm();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Templates</h2>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="template-layout">
          {/* Left: template list */}
          <div className="template-list">
            <button className="btn btn-secondary btn-sm template-new-btn" onClick={startCreate}>
              + New Template
            </button>
            {templates.length === 0 && !creating && (
              <p className="sidebar-empty">No templates yet</p>
            )}
            {templates.map(t => (
              <div
                key={t.id}
                className={`template-item ${editing?.id === t.id ? 'template-item-active' : ''}`}
                onClick={() => startEdit(t)}
              >
                <span className="template-item-name">{t.name}</span>
                <button
                  className="btn-icon template-delete-btn"
                  onClick={e => { e.stopPropagation(); handleDelete(t); }}
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Right: editor */}
          <div className="template-editor">
            {(creating || editing) ? (
              <form onSubmit={handleSave} className="template-form">
                <div className="form-group">
                  <label htmlFor="tpl-name">Name</label>
                  <input
                    id="tpl-name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Code review standards"
                    autoFocus
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="tpl-workdir">Working Directory <span className="form-label-hint">(optional)</span></label>
                  <input
                    id="tpl-workdir"
                    type="text"
                    value={workDir}
                    onChange={e => setWorkDir(e.target.value)}
                    placeholder="/path/to/project"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="tpl-model">Model <span className="form-label-hint">(optional, prefills job form)</span></label>
                  <select
                    id="tpl-model"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                  >
                    <option value="">No preference (auto-select)</option>
                    <option value="claude-opus-4-6[1m]">claude-opus-4-6[1m] — most capable, 1M context</option>
                    <option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m] — balanced, 1M context</option>
                    <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 — fastest, cheapest</option>
                  </select>
                </div>
                <div className="form-group template-content-group">
                  <label htmlFor="tpl-content">Content</label>
                  <textarea
                    id="tpl-content"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder="Text that will be prepended to every job that uses this template..."
                    required
                  />
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={cancelForm}>Cancel</button>
                  {editing && (
                    <button type="button" className="btn btn-danger" onClick={() => handleDelete(editing)}>
                      Delete
                    </button>
                  )}
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Template'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="template-editor-empty">
                Select a template to edit, or create a new one.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
