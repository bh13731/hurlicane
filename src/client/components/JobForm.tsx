import React, { useState, useEffect } from 'react';
import type { CreateJobRequest, Job, Template, RetryPolicy, ReviewConfig, Repo, Worktree } from '@shared/types';
import { TemplateModelStats } from './TemplateModelStats';

interface JobFormProps {
  onSubmit: (job: CreateJobRequest) => Promise<void>;
  onClose: () => void;
  availableJobs?: Job[];
}

export function JobForm({ onSubmit, onClose, availableJobs = [] }: JobFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [model, setModel] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [interactive, setInteractive] = useState(true);
  const [repeatSeconds, setRepeatSeconds] = useState<number | ''>('');
  const [retryPolicy, setRetryPolicy] = useState<RetryPolicy>('none');
  const [maxRetries, setMaxRetries] = useState(3);
  const [checkDiffNotEmpty, setCheckDiffNotEmpty] = useState(false);
  const [checkNoErrors, setCheckNoErrors] = useState(false);
  const [customCheckCmd, setCustomCheckCmd] = useState('');
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewModels, setReviewModels] = useState<string[]>([]);
  const [reviewAuto, setReviewAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Worktree-branch state
  const [branchMode, setBranchMode] = useState<'existing' | 'new'>('new');
  const [selectedWorktreeId, setSelectedWorktreeId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchRepoId, setBranchRepoId] = useState('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);

  const pendingJobs = availableJobs.filter(
    j => j.status === 'queued' || j.status === 'assigned' || j.status === 'running'
  );

  const toggleDepend = (id: string) => {
    setDependsOn(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
    fetch('/api/repos').then(r => r.json()).then(setRepos).catch(() => {});
    fetch('/api/worktrees').then(r => r.json()).then((wts: Worktree[]) => {
      setWorktrees(wts);
      // Default to existing worktree mode if any exist
      if (wts.length > 0) setBranchMode('existing');
    }).catch(() => {});
  }, []);

  const selectedTemplate = templates.find(t => t.id === templateId) ?? null;

  const handleTemplateChange = (newTemplateId: string) => {
    setTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.model) {
      setModel(tpl.model);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() && !templateId) return;
    setLoading(true);
    setError(null);
    try {
      const completionChecks: string[] = [];
      if (checkDiffNotEmpty) completionChecks.push('diff_not_empty');
      if (checkNoErrors) completionChecks.push('no_error_in_output');
      if (customCheckCmd.trim()) completionChecks.push(`custom_command:${customCheckCmd.trim()}`);

      const reviewConfig: ReviewConfig | undefined = reviewEnabled && reviewModels.length > 0
        ? { models: reviewModels, auto: reviewAuto }
        : undefined;

      const selectedWorktree = worktrees.find(w => w.id === selectedWorktreeId);
      const selectedRepo = repos.find(r => r.id === branchRepoId);
      // If using an existing worktree, pass its path as workDir so the job runs there
      const workDir = branchMode === 'existing' && selectedWorktree
        ? selectedWorktree.path
        : selectedRepo?.path || undefined;

      await onSubmit({
        title: title.trim() || undefined,
        description: description.trim(),
        workDir,
        priority,
        model: model.trim() || undefined,
        templateId: templateId || undefined,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        interactive: interactive || undefined,
        useWorktree: true,
        repeatIntervalMs: repeatSeconds ? (repeatSeconds as number) * 1000 : undefined,
        retryPolicy: retryPolicy !== 'none' ? retryPolicy : undefined,
        maxRetries: retryPolicy !== 'none' ? maxRetries : undefined,
        completionChecks: completionChecks.length > 0 ? completionChecks : undefined,
        reviewConfig,
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
            <label htmlFor="description">
              Task Description
              {templateId && <span className="form-label-hint"> (optional — template is the task)</span>}
            </label>
            <textarea
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={templateId ? "Additional instructions (optional)..." : "Detailed instructions for the agent..."}
              rows={6}
              required={!templateId}
            />
          </div>

          <div className="form-group">
            <label>Worktree</label>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <label className="form-checkbox-label">
                <input
                  type="radio"
                  name="branchMode"
                  checked={branchMode === 'existing'}
                  onChange={() => setBranchMode('existing')}
                  disabled={worktrees.length === 0}
                />
                Existing branch
              </label>
              <label className="form-checkbox-label">
                <input
                  type="radio"
                  name="branchMode"
                  checked={branchMode === 'new'}
                  onChange={() => setBranchMode('new')}
                />
                New branch
              </label>
            </div>
            {branchMode === 'existing' ? (
              <select
                value={selectedWorktreeId}
                onChange={e => setSelectedWorktreeId(e.target.value)}
              >
                <option value="">Select a branch</option>
                {worktrees.map(wt => {
                  const repo = repos.find(r => r.id === wt.repo_id);
                  return (
                    <option key={wt.id} value={wt.id}>
                      {wt.branch}{repo ? ` (${repo.name})` : ''}
                    </option>
                  );
                })}
              </select>
            ) : (
              <div className="form-row">
                <div className="form-group">
                  <label>Repo</label>
                  <select
                    value={branchRepoId}
                    onChange={e => setBranchRepoId(e.target.value)}
                  >
                    {repos.length === 0 ? (
                      <option value="" disabled>No repos registered</option>
                    ) : (
                      <>
                        <option value="">Select a repo</option>
                        {repos.map(r => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </>
                    )}
                  </select>
                </div>
                <div className="form-group">
                  <label>Branch <span className="form-label-hint">(optional, auto-generated if blank)</span></label>
                  <input
                    type="text"
                    value={branchName}
                    onChange={e => setBranchName(e.target.value)}
                    placeholder="auto-generated from title"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="form-row">
            <div className="form-group form-group-sm">
              <label htmlFor="priority">
                Priority
                <span className="tooltip-icon" data-tip="Controls dispatch order when multiple jobs are waiting. Higher = started sooner (range: −10 to 10). If agent slots are free, all jobs start immediately regardless of priority.">?</span>
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

          <TemplateModelStats templateId={templateId} model={model} />

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
            <label htmlFor="repeatSeconds">
              Repeat every
              <span className="tooltip-icon" data-tip="After the job completes, automatically re-queue it after this many seconds. Leave blank for no repeat.">?</span>
            </label>
            <div className="repeat-input-row">
              <input
                id="repeatSeconds"
                type="number"
                value={repeatSeconds}
                onChange={e => setRepeatSeconds(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="no repeat"
                min={1}
              />
              <span className="repeat-unit">seconds</span>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="retryPolicy">
                On Failure
                <span className="tooltip-icon" data-tip="What to do when the agent fails. 'Retry same' re-queues the identical task. 'Analyze & retry' spawns a lightweight agent to diagnose the failure and create a refined retry.">?</span>
              </label>
              <select
                id="retryPolicy"
                value={retryPolicy}
                onChange={e => setRetryPolicy(e.target.value as RetryPolicy)}
              >
                <option value="none">No retry</option>
                <option value="same">Retry same</option>
                <option value="analyze">Analyze & retry</option>
              </select>
            </div>
            {retryPolicy !== 'none' && (
              <div className="form-group form-group-sm">
                <label htmlFor="maxRetries">Max Retries</label>
                <input
                  id="maxRetries"
                  type="number"
                  value={maxRetries}
                  onChange={e => setMaxRetries(Number(e.target.value))}
                  min={1}
                  max={10}
                />
              </div>
            )}
          </div>

          <div className="form-group">
            <label>
              Completion Checks
              <span className="tooltip-icon" data-tip="Validate agent output before accepting 'done'. Failed checks convert the job to 'failed' and can trigger retry.">?</span>
            </label>
            <div className="completion-checks-list">
              <label className="form-checkbox-label">
                <input
                  type="checkbox"
                  checked={checkDiffNotEmpty}
                  onChange={e => setCheckDiffNotEmpty(e.target.checked)}
                />
                Diff not empty
              </label>
              <label className="form-checkbox-label">
                <input
                  type="checkbox"
                  checked={checkNoErrors}
                  onChange={e => setCheckNoErrors(e.target.checked)}
                />
                No errors in output
              </label>
            </div>
            <input
              type="text"
              value={customCheckCmd}
              onChange={e => setCustomCheckCmd(e.target.value)}
              placeholder="Custom check command (exit 0 = pass)"
              style={{ marginTop: 6 }}
            />
          </div>

          <div className="form-group">
            <label className="form-checkbox-label">
              <input
                type="checkbox"
                checked={reviewEnabled}
                onChange={e => setReviewEnabled(e.target.checked)}
              />
              Review on completion
              <span className="tooltip-icon" data-tip="After job completes, spawn review agents to validate the work. Job is marked approved only if reviews pass.">?</span>
            </label>
          </div>

          {reviewEnabled && (
            <div className="form-group" style={{ paddingLeft: 20 }}>
              <label>Review Models</label>
              <div className="completion-checks-list">
                {[
                  { value: 'claude-haiku-4-5-20251001', label: 'Haiku' },
                  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet' },
                  { value: 'claude-opus-4-6[1m]', label: 'Opus' },
                ].map(m => (
                  <label key={m.value} className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={reviewModels.includes(m.value)}
                      onChange={e => setReviewModels(prev =>
                        e.target.checked ? [...prev, m.value] : prev.filter(x => x !== m.value)
                      )}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              <label className="form-checkbox-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={reviewAuto}
                  onChange={e => setReviewAuto(e.target.checked)}
                />
                Auto-trigger reviews
              </label>
            </div>
          )}

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
