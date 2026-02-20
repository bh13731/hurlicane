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

function HurlwindLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer vortex arm */}
      <path
        d="M85 35C85 35 78 18 58 14C38 10 18 22 15 42C12 62 28 78 48 78"
        stroke="#58a6ff" strokeWidth="6" strokeLinecap="round" fill="none"
      />
      {/* Middle vortex arm */}
      <path
        d="M72 58C72 58 70 72 56 76C42 80 30 70 30 56C30 42 42 36 52 38"
        stroke="#79c0ff" strokeWidth="5" strokeLinecap="round" fill="none"
      />
      {/* Inner spiral core */}
      <path
        d="M44 50C44 50 44 42 52 42C60 42 62 50 56 54C50 58 44 54 46 48"
        stroke="#a5d6ff" strokeWidth="4" strokeLinecap="round" fill="none"
      />
      {/* Speed streaks */}
      <path d="M82 28L92 22" stroke="#58a6ff" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
      <path d="M88 40L96 38" stroke="#58a6ff" strokeWidth="2.5" strokeLinecap="round" opacity="0.4" />
    </svg>
  );
}

export function Header({ onNewJob, onTemplates, onUsage, onSearch, onTimeline, onDag, todayCost }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <HurlwindLogo />
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
