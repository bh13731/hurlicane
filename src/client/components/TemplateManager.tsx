import React, { useEffect, useState } from 'react';
import type { Template, Repo, Project, RetryPolicy } from '@shared/types';

interface TemplateManagerProps {
  onClose: () => void;
}

export function TemplateManager({ onClose }: TemplateManagerProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('');
  const [isReadonly, setIsReadonly] = useState(false);
  const [repoId, setRepoId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [priority, setPriority] = useState(0);
  const [isInteractive, setIsInteractive] = useState(false);
  const [retryPolicy, setRetryPolicy] = useState<RetryPolicy>('none');
  const [maxRetries, setMaxRetries] = useState(3);
  const [completionChecks, setCompletionChecks] = useState('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteTpl, setConfirmDeleteTpl] = useState<Template | null>(null);

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
    fetch('/api/repos').then(r => r.json()).then(setRepos).catch(() => {});
    fetch('/api/projects').then(r => r.json()).then(setProjects).catch(() => {});
  }, []);

  function startCreate() {
    setEditing(null);
    setName('');
    setContent('');
    setModel('');
    setIsReadonly(false);
    setRepoId('');
    setProjectId('');
    setPriority(0);
    setIsInteractive(false);
    setRetryPolicy('none');
    setMaxRetries(3);
    setCompletionChecks('');
    setCreating(true);
  }

  function startEdit(t: Template) {
    setCreating(false);
    setEditing(t);
    setName(t.name);
    setContent(t.content);
    setModel(t.model ?? '');
    setIsReadonly(!!t.is_readonly);
    setRepoId(t.repo_id ?? '');
    setProjectId(t.project_id ?? '');
    setPriority(t.priority ?? 0);
    setIsInteractive(!!t.is_interactive);
    setRetryPolicy(t.retry_policy ?? 'none');
    setMaxRetries(t.max_retries ?? 3);
    // Parse completion_checks JSON array into comma-separated string for editing
    try {
      const checks = t.completion_checks ? JSON.parse(t.completion_checks) : [];
      setCompletionChecks(Array.isArray(checks) ? checks.join(', ') : '');
    } catch { setCompletionChecks(''); }
  }

  function cancelForm() {
    setCreating(false);
    setEditing(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    setSaving(true);

    const checksArray = completionChecks.split(',').map(s => s.trim()).filter(Boolean);

    const payload = {
      name: name.trim(),
      content: content.trim(),
      model: model.trim() || null,
      is_readonly: isReadonly,
      repo_id: repoId || null,
      project_id: projectId || null,
      priority,
      is_interactive: isInteractive,
      retry_policy: retryPolicy,
      max_retries: retryPolicy !== 'none' ? maxRetries : 0,
      completion_checks: checksArray.length > 0 ? checksArray : null,
    };

    try {
      if (editing) {
        const res = await fetch(`/api/templates/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const updated: Template = await res.json();
        setTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
      } else {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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
    await fetch(`/api/templates/${t.id}`, { method: 'DELETE' });
    setTemplates(prev => prev.filter(x => x.id !== t.id));
    if (editing?.id === t.id) cancelForm();
    setConfirmDeleteTpl(null);
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
                  onClick={e => { e.stopPropagation(); setConfirmDeleteTpl(t); }}
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
                    <option value="codex">codex — default (gpt-5.3-codex)</option>
                    <option value="codex-gpt-5.3-codex">codex — gpt-5.3-codex</option>
                    <option value="codex-gpt-5.2-codex">codex — gpt-5.2-codex</option>
                    <option value="codex-gpt-5.1-codex-max">codex — gpt-5.1-codex-max</option>
                    <option value="codex-gpt-5.2">codex — gpt-5.2</option>
                    <option value="codex-gpt-5.1-codex-mini">codex — gpt-5.1-codex-mini</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={isReadonly}
                      onChange={e => setIsReadonly(e.target.checked)}
                    />
                    Readonly (no file edits)
                    <span className="tooltip-icon" data-tip="Jobs using this template will be forced into readonly mode — no worktree, no file edits allowed.">?</span>
                  </label>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="tpl-repo">Default Repo</label>
                    <select id="tpl-repo" value={repoId} onChange={e => setRepoId(e.target.value)}>
                      <option value="">None</option>
                      {repos.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="tpl-project">Default Project</label>
                    <select id="tpl-project" value={projectId} onChange={e => setProjectId(e.target.value)}>
                      <option value="">None</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group form-group-sm">
                    <label htmlFor="tpl-priority">Priority</label>
                    <input id="tpl-priority" type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} min={-10} max={10} />
                  </div>
                  <div className="form-group">
                    <label className="form-checkbox-label" style={{ marginTop: 22 }}>
                      <input type="checkbox" checked={isInteractive} onChange={e => setIsInteractive(e.target.checked)} />
                      Interactive
                    </label>
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="tpl-retry">On Failure</label>
                    <select id="tpl-retry" value={retryPolicy} onChange={e => setRetryPolicy(e.target.value as RetryPolicy)}>
                      <option value="none">No retry</option>
                      <option value="same">Retry same</option>
                      <option value="analyze">Analyze & retry</option>
                    </select>
                  </div>
                  {retryPolicy !== 'none' && (
                    <div className="form-group form-group-sm">
                      <label htmlFor="tpl-max-retries">Max Retries</label>
                      <input id="tpl-max-retries" type="number" value={maxRetries} onChange={e => setMaxRetries(Number(e.target.value))} min={1} max={10} />
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label htmlFor="tpl-checks">Completion Checks <span className="form-label-hint">(comma-separated)</span></label>
                  <input
                    id="tpl-checks"
                    type="text"
                    value={completionChecks}
                    onChange={e => setCompletionChecks(e.target.value)}
                    placeholder="e.g. diff_not_empty, no_error_in_output"
                  />
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
                    <button type="button" className="btn btn-danger" onClick={() => setConfirmDeleteTpl(editing)}>
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
      {confirmDeleteTpl && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteTpl(null)}>
          <div className="modal" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete Template</h2>
              <button className="btn-icon" onClick={() => setConfirmDeleteTpl(null)} aria-label="Close">&times;</button>
            </div>
            <div className="confirm-body">
              <p className="confirm-text">Delete <strong>{confirmDeleteTpl.name}</strong>? This cannot be undone.</p>
              <div className="confirm-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDeleteTpl(null)}>Cancel</button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(confirmDeleteTpl)}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
