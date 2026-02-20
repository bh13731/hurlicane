import React from 'react';
import type { Job } from '@shared/types';

interface WorkQueueSidebarProps {
  jobs: Job[];
  onSelectJob?: (job: Job) => void;
}

function statusOrder(status: string): number {
  const order: Record<string, number> = { queued: 0, assigned: 1, running: 2, done: 3, failed: 4, cancelled: 5 };
  return order[status] ?? 99;
}

export function WorkQueueSidebar({ jobs, onSelectJob }: WorkQueueSidebarProps) {
  const queued = jobs.filter(j => j.status === 'queued');
  const active = jobs.filter(j => j.status === 'assigned' || j.status === 'running');
  const done = jobs
    .filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => b.updated_at - a.updated_at);

  return (
    <aside className="sidebar">
      <h2 className="sidebar-title">Work Queue</h2>

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
