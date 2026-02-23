import React from 'react';
import type { Job, Project } from '@shared/types';

interface WorkQueueSidebarProps {
  jobs: Job[];
  projects?: Project[];
  onSelectJob?: (job: Job) => void;
  onCancelJob?: (job: Job) => void;
  onRunJobNow?: (job: Job) => void;
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatTimeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return 'now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

export function WorkQueueSidebar({ jobs, projects = [], onSelectJob, onCancelJob, onRunJobNow }: WorkQueueSidebarProps) {
  const projectMap = Object.fromEntries(projects.map(p => [p.id, p.name]));

  const queued = jobs.filter(j => j.status === 'queued');
  const active = jobs.filter(j => j.status === 'assigned' || j.status === 'running');
  const done = jobs
    .filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => b.updated_at - a.updated_at);

  const ProjectTag = ({ job }: { job: Job }) =>
    job.project_id && projectMap[job.project_id] ? (
      <span className="sidebar-job-project">{projectMap[job.project_id]}</span>
    ) : null;

  const RepeatBadge = ({ job }: { job: Job }) =>
    job.repeat_interval_ms ? (
      <span className="sidebar-job-repeat" title={`Repeats every ${formatInterval(job.repeat_interval_ms)}`}>
        ↻ {formatInterval(job.repeat_interval_ms)}
      </span>
    ) : null;

  const ScheduledBadge = ({ job }: { job: Job }) => {
    if (!job.scheduled_at || job.scheduled_at <= Date.now()) return null;
    const label = `in ${formatTimeUntil(job.scheduled_at)}`;
    return (
      <span
        className="sidebar-job-scheduled"
        title={`Scheduled to run in ${formatTimeUntil(job.scheduled_at)} — click to run now`}
        onClick={e => {
          e.stopPropagation();
          if (window.confirm(`Run "${job.title}" now instead of in ${formatTimeUntil(job.scheduled_at!)}?`)) {
            onRunJobNow?.(job);
          }
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <aside className="sidebar">
      <h2 className="sidebar-title">Activity Feed</h2>

      {active.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">active ({active.length})</div>
          {active.map(job => (
            <div
              key={job.id}
              className="sidebar-job sidebar-job-active sidebar-job-clickable"
              onClick={() => onSelectJob?.(job)}
            >
              <span className="sidebar-job-title">{job.title}</span>
              <RepeatBadge job={job} />
              <ProjectTag job={job} />
            </div>
          ))}
        </div>
      )}

      {queued.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">queued ({queued.length})</div>
          {queued.map(job => (
            <div key={job.id} className="sidebar-job">
              <span className="sidebar-job-bullet">•</span>
              <span className="sidebar-job-title">{job.title}</span>
              <ScheduledBadge job={job} />
              <RepeatBadge job={job} />
              <ProjectTag job={job} />
              {onCancelJob && (
                <button
                  className="sidebar-job-cancel"
                  onClick={e => { e.stopPropagation(); onCancelJob(job); }}
                  title="Cancel job"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">done ({done.length})</div>
          {done.slice(0, 10).map(job => (
            <div
              key={job.id}
              className={`sidebar-job sidebar-job-${job.status} sidebar-job-clickable`}
              onClick={() => onSelectJob?.(job)}
            >
              <span className="sidebar-job-bullet">{job.status === 'done' ? '✓' : job.status === 'failed' ? '✗' : '⊘'}</span>
              <span className="sidebar-job-title">{job.title}</span>
              <RepeatBadge job={job} />
              <ProjectTag job={job} />
            </div>
          ))}
        </div>
      )}

      {jobs.length === 0 && (
        <p className="sidebar-empty">No jobs yet</p>
      )}
    </aside>
  );
}
