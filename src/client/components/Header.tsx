import React from 'react';

interface HeaderProps {
  onNewJob: () => void;
  onTemplates: () => void;
  onUsage: () => void;
  onSearch: () => void;
  onTimeline: () => void;
  onDag: () => void;
  todayCost?: number;
}

export function Header({ onNewJob, onTemplates, onUsage, onSearch, onTimeline, onDag, todayCost }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">Hurlwind</h1>
        {todayCost != null && todayCost > 0 && (
          <div className="header-cost" title="Total cost of agents started today">
            ${todayCost.toFixed(4)} today
          </div>
        )}
      </div>
      <div className="header-actions">
        <button className="btn btn-secondary" onClick={onSearch}>
          Search
        </button>
        <button className="btn btn-secondary" onClick={onTimeline}>
          Timeline
        </button>
        <button className="btn btn-secondary" onClick={onDag}>
          Graph
        </button>
        <button className="btn btn-secondary" onClick={onUsage}>
          Usage
        </button>
        <button className="btn btn-secondary" onClick={onTemplates}>
          Templates
        </button>
        <button className="btn btn-primary" onClick={onNewJob}>
          + New Job
        </button>
      </div>
    </header>
  );
}
