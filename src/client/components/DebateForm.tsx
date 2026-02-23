import React, { useState, useEffect } from 'react';
import type { CreateDebateRequest, Template } from '@shared/types';

interface DebateFormProps {
  onSubmit: (req: CreateDebateRequest) => Promise<void>;
  onClose: () => void;
}

export function DebateForm({ onSubmit, onClose }: DebateFormProps) {
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [claudeModel, setClaudeModel] = useState('claude-sonnet-4-6[1m]');
  const [codexModel, setCodexModel] = useState('codex');
  const [maxRounds, setMaxRounds] = useState(3);
  const [workDir, setWorkDir] = useState('');
  const [maxTurns, setMaxTurns] = useState(50);
  const [templateId, setTemplateId] = useState('');
  const [postActionPrompt, setPostActionPrompt] = useState('');
  const [postActionRole, setPostActionRole] = useState<'claude' | 'codex'>('claude');
  const [postActionVerification, setPostActionVerification] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  const handleTemplateChange = (newTemplateId: string) => {
    setTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.work_dir) {
      setWorkDir(tpl.work_dir);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    setLoading(true);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        task: task.trim(),
        claudeModel,
        codexModel,
        maxRounds,
        workDir: workDir.trim() || undefined,
        maxTurns,
        templateId: templateId || undefined,
        postActionPrompt: postActionPrompt.trim() || undefined,
        postActionRole: postActionPrompt.trim() ? postActionRole : undefined,
        postActionVerification: postActionPrompt.trim() ? postActionVerification : undefined,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Debate</h2>
          <button className="btn-icon" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit} className="job-form">
          <div className="form-group">
            <label htmlFor="debate-title">Title <span className="form-label-hint">(optional)</span></label>
            <input
              id="debate-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Auto-generated from task if blank"
              autoFocus
            />
          </div>

          {templates.length > 0 && (
            <div className="form-group">
              <label htmlFor="debate-template">Template <span className="form-label-hint">(optional)</span></label>
              <select
                id="debate-template"
                value={templateId}
                onChange={e => handleTemplateChange(e.target.value)}
              >
                <option value="">None</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="debate-task">Task Description</label>
            <textarea
              id="debate-task"
              value={task}
              onChange={e => setTask(e.target.value)}
              placeholder="Describe the task both sides will analyze and debate..."
              rows={6}
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="debate-claude-model">Claude Model</label>
              <select
                id="debate-claude-model"
                value={claudeModel}
                onChange={e => setClaudeModel(e.target.value)}
              >
                <option value="claude-opus-4-6[1m]">claude-opus-4-6[1m]</option>
                <option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m]</option>
                <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="debate-codex-model">Codex Model</label>
              <select
                id="debate-codex-model"
                value={codexModel}
                onChange={e => setCodexModel(e.target.value)}
              >
                <option value="codex">codex (default)</option>
                <option value="codex-gpt-5.3-codex">codex-gpt-5.3-codex</option>
                <option value="codex-gpt-5.2-codex">codex-gpt-5.2-codex</option>
                <option value="codex-gpt-5.1-codex-max">codex-gpt-5.1-codex-max</option>
                <option value="codex-gpt-5.2">codex-gpt-5.2</option>
                <option value="codex-gpt-5.1-codex-mini">codex-gpt-5.1-codex-mini</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group form-group-sm">
              <label htmlFor="debate-max-rounds">Max Rounds</label>
              <input
                id="debate-max-rounds"
                type="number"
                value={maxRounds}
                onChange={e => setMaxRounds(Number(e.target.value))}
                min={1}
                max={10}
              />
            </div>
            <div className="form-group form-group-sm">
              <label htmlFor="debate-max-turns">Max Turns</label>
              <input
                id="debate-max-turns"
                type="number"
                value={maxTurns}
                onChange={e => setMaxTurns(Number(e.target.value))}
                min={1}
                max={200}
              />
            </div>
            <div className="form-group">
              <label htmlFor="debate-workdir">Working Directory</label>
              <input
                id="debate-workdir"
                type="text"
                value={workDir}
                onChange={e => setWorkDir(e.target.value)}
                placeholder="/path/to/project (optional)"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="debate-post-action">Post-Debate Action <span className="form-label-hint">(optional — runs after debate concludes)</span></label>
            <textarea
              id="debate-post-action"
              value={postActionPrompt}
              onChange={e => setPostActionPrompt(e.target.value)}
              placeholder="e.g. Implement what you agreed upon"
              rows={3}
            />
          </div>

          {postActionPrompt.trim() && (
            <div className="form-group">
              <label>Run action with</label>
              <div className="radio-group">
                <label className="radio-label">
                  <input type="radio" value="claude" checked={postActionRole === 'claude'} onChange={() => setPostActionRole('claude')} />
                  Claude ({claudeModel})
                </label>
                <label className="radio-label">
                  <input type="radio" value="codex" checked={postActionRole === 'codex'} onChange={() => setPostActionRole('codex')} />
                  Codex ({codexModel})
                </label>
              </div>
            </div>
          )}

          {postActionPrompt.trim() && (
            <div className="form-group">
              <label className="form-checkbox-label">
                <input
                  type="checkbox"
                  checked={postActionVerification}
                  onChange={e => setPostActionVerification(e.target.checked)}
                />
                Verification
                <span className="form-label-hint" style={{ marginLeft: 4 }}>
                  (after action, the other model reviews and the implementer can apply feedback)
                </span>
              </label>
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Starting...' : 'Start Debate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
