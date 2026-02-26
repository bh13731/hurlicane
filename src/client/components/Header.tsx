import React from 'react';

interface HeaderProps {
  onNewJob: () => void;
  onTemplates: () => void;
  onBatchTemplates: () => void;
  onUsage: () => void;
  onSearch: () => void;
  onTimeline: () => void;
  onDag: () => void;
  onProjects: () => void;
  onSettings: () => void;
  onDebate: () => void;
  onKnowledgeBase: () => void;
  onHome: () => void;
  currentProjectName?: string | null;
  onClearProject?: () => void;
  todayClaudeCost?: number;
  todayCodexCost?: number;
}

function HurlicaLogo() {
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

export function Header({ onNewJob, onTemplates, onBatchTemplates, onUsage, onSearch, onTimeline, onDag, onProjects, onSettings, onDebate, onKnowledgeBase, onHome, currentProjectName, onClearProject, todayClaudeCost, todayCodexCost }: HeaderProps) {
  const hasCost = (todayClaudeCost != null && todayClaudeCost > 0) || (todayCodexCost != null && todayCodexCost > 0);
  return (
    <header className="header">
      <div className="header-left">
        <button className="header-logo-btn" onClick={onHome} title="Go to main page" aria-label="Go to main dashboard">
          <HurlicaLogo />
          <h1 className="header-title">Hurlicane</h1>
        </button>
        {currentProjectName && (
          <div className="header-project-badge" title={`Active project: ${currentProjectName}`}>
            {currentProjectName}
            <button className="header-project-clear" onClick={onClearProject} aria-label={`Clear project filter: ${currentProjectName}`}>&times;</button>
          </div>
        )}
        {hasCost && (
          <div className="header-cost" title="Today's spend">
            {todayClaudeCost != null && todayClaudeCost > 0 && (
              <span title="Claude cost today">Claude ${todayClaudeCost.toFixed(4)}</span>
            )}
            {todayClaudeCost != null && todayClaudeCost > 0 && todayCodexCost != null && todayCodexCost > 0 && (
              <span style={{ opacity: 0.4, margin: '0 4px' }}>|</span>
            )}
            {todayCodexCost != null && todayCodexCost > 0 && (
              <span title="Codex cost today" style={{ color: 'var(--codex)' }}>Codex ${todayCodexCost.toFixed(4)}</span>
            )}
            <span style={{ opacity: 0.6, marginLeft: 4 }}>today</span>
          </div>
        )}
      </div>
      <div className="header-actions">
        <input
          type="text"
          className="search-input-header"
          placeholder="⌘ Search..."
          readOnly
          onFocus={onSearch}
        />
        <span className="header-divider" />
        <div className="header-btn-group" title="Visualizations">
          <button className="header-btn" onClick={onTimeline}>Timeline</button>
          <button className="header-btn" onClick={onDag}>Graph</button>
          <button className="header-btn" onClick={onUsage}>Usage</button>
        </div>
        <span className="header-divider" />
        <div className="header-btn-group" title="Management">
          <button className="header-btn" onClick={onProjects}>Projects</button>
          <button className="header-btn" onClick={onTemplates}>Templates</button>
          <button className="header-btn" onClick={onBatchTemplates}>Batches</button>
          <button className="header-btn" onClick={onDebate}>Debate</button>
          <button className="header-btn" onClick={onKnowledgeBase}>Memory</button>
        </div>
        <span className="header-divider" />
        <button className="btn-icon" onClick={onSettings} title="Settings" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>
        </button>
        <button className="btn btn-primary btn-sm" onClick={onNewJob}>
          + New Job
        </button>
      </div>
    </header>
  );
}
