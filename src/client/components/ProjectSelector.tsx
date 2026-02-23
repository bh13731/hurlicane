import React, { useState } from 'react';
import type { Project } from '@shared/types';

interface ProjectSelectorProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  onCreate: (name: string, description: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function ProjectSelector({ projects, activeProjectId, onSelect, onCreate, onDelete, onClose }: ProjectSelectorProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim(), description.trim());
    setName('');
    setDescription('');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Projects</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div style={{ padding: '12px 20px' }}>
          {/* Main Dashboard option */}
          <div
            className={`project-item ${activeProjectId === null ? 'project-item-active' : ''}`}
            onClick={() => { onSelect(null); onClose(); }}
          >
            <span>Main Dashboard</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>all unscoped jobs</span>
          </div>

          {/* Project list */}
          {projects.map(p => (
            <div
              key={p.id}
              className={`project-item ${activeProjectId === p.id ? 'project-item-active' : ''}`}
              onClick={() => { onSelect(p.id); onClose(); }}
            >
              <span>{p.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.description && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.description}</span>}
                <button
                  className="btn-icon"
                  style={{ fontSize: 13, padding: '2px 4px' }}
                  title="Delete project"
                  onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(p.id); }}
                >
                  &times;
                </button>
              </div>
            </div>
          ))}

          {projects.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '12px 0' }}>No projects yet. Create one below.</p>
          )}

          {/* Create form */}
          <form className="project-create-form" onSubmit={handleCreate}>
            <input
              type="text"
              placeholder="Project name"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={!name.trim()}>
              Create
            </button>
          </form>
        </div>
      </div>
      {confirmDeleteId && (() => {
        const project = projects.find(p => p.id === confirmDeleteId);
        return (
          <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
            <div className="modal" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Delete Project</h2>
                <button className="btn-icon" onClick={() => setConfirmDeleteId(null)} aria-label="Close">&times;</button>
              </div>
              <div className="confirm-body">
                <p className="confirm-text">
                  Delete <strong>{project?.name}</strong>? This cannot be undone.
                </p>
                <div className="confirm-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => { onDelete(confirmDeleteId); setConfirmDeleteId(null); }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
