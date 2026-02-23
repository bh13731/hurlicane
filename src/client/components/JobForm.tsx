import React, { useState, useEffect } from 'react';
import type { CreateJobRequest, Job, Template } from '@shared/types';

interface JobFormProps {
  onSubmit: (job: CreateJobRequest) => Promise<void>;
  onClose: () => void;
  availableJobs?: Job[];
}

export function JobForm({ onSubmit, onClose, availableJobs = [] }: JobFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [priority, setPriority] = useState(0);
  const [maxTurns, setMaxTurns] = useState(50);
  const [model, setModel] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [interactive, setInteractive] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingJobs = availableJobs.filter(
    j => j.status === 'queued' || j.status === 'assigned' || j.status === 'running'
  );

  const toggleDepend = (id: string) => {
    setDependsOn(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  const selectedTemplate = templates.find(t => t.id === templateId) ?? null;

  const handleTemplateChange = (newTemplateId: string) => {
    setTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.work_dir) {
      setWorkDir(tpl.work_dir);
    }
    if (tpl?.model) {
      setModel(tpl.model);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        description: description.trim(),
        workDir: workDir.trim() || undefined,
        priority,
        maxTurns,
        model: model.trim() || undefined,
        templateId: templateId || undefined,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        interactive: interactive || undefined,
        useWorktree: useWorktree || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit job');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Job</h2>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="job-form">
          <div className="form-group">
            <label htmlFor="title">Title <span className="form-label-hint">(optional, auto-generated if blank)</span></label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Leave blank to auto-generate from description"
              autoFocus
            />
          </div>

          {/* Template selector */}
          <div className="form-group">
            <label htmlFor="templateId">Template <span className="form-label-hint">(optional)</span></label>
            <select
              id="templateId"
              value={templateId}
              onChange={e => handleTemplateChange(e.target.value)}
            >
              <option value="">None</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {selectedTemplate && (
              <div className="template-preview">
                {selectedTemplate.content.slice(0, 200)}
                {selectedTemplate.content.length > 200 ? '…' : ''}
              </div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="description">Task Description</label>
            <textarea
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Detailed instructions for the agent..."
              rows={6}
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="workDir">Working Directory</label>
              <input
                id="workDir"
                type="text"
                value={workDir}
                onChange={e => setWorkDir(e.target.value)}
                placeholder="/path/to/project (optional)"
              />
            </div>
            <div className="form-group form-group-sm">
              <label htmlFor="priority">
                Priority
                <span
                  className="tooltip-icon"
                  data-tip="Controls dispatch order when multiple jobs are waiting. Higher = started sooner (range: −10 to 10). If agent slots are free, all jobs start immediately regardless of priority."
                >?</span>
              </label>
              <input
                id="priority"
                type="number"
                value={priority}
                onChange={e => setPriority(Number(e.target.value))}
                min={-10}
                max={10}
              />
            </div>
            <div className="form-group form-group-sm">
              <label htmlFor="maxTurns">Max Turns</label>
              <input
                id="maxTurns"
                type="number"
                value={maxTurns}
                onChange={e => setMaxTurns(Number(e.target.value))}
                min={1}
                max={200}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="model">Model <span className="form-label-hint">(leave blank to auto-select)</span></label>
            <select
              id="model"
              value={model}
              onChange={e => setModel(e.target.value)}
            >
              <option value="">Auto-select (Haiku classifies the task)</option>
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

          {pendingJobs.length > 0 && (
            <div className="form-group">
              <label>
                Depends On <span className="form-label-hint">(optional — job won't start until selected jobs finish)</span>
              </label>
              <div className="depends-on-list">
                {pendingJobs.map(j => (
                  <label key={j.id} className="depends-on-item">
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(j.id)}
                      onChange={() => toggleDepend(j.id)}
                    />
                    <span className={`depends-on-status status-${j.status}`}>{j.status}</span>
                    <span className="depends-on-title">{j.title}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-checkbox-label">
              <input
                type="checkbox"
                checked={interactive}
                onChange={e => setInteractive(e.target.checked)}
              />
              Interactive session
              <span className="tooltip-icon" data-tip="Keeps terminal open for direct conversation">?</span>
            </label>
          </div>

          <div className="form-group">
            <label className="form-checkbox-label">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={e => setUseWorktree(e.target.checked)}
              />
              Use worktree
              <span className="tooltip-icon" data-tip="Creates a git worktree so the agent works in an isolated checkout on a new branch">?</span>
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Submitting...' : 'Submit Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
