import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Header } from './components/Header';
import { AgentGrid } from './components/AgentGrid';
import { AgentTerminal } from './components/AgentTerminal';
import { WorkQueueSidebar } from './components/WorkQueueSidebar';
import { FileLockMap } from './components/FileLockMap';
import { JobForm } from './components/JobForm';
import { TemplateManager } from './components/TemplateManager';
import { BatchTemplateManager } from './components/BatchTemplateManager';
import { UsageModal } from './components/UsageModal';
import { SearchModal } from './components/SearchModal';
import { GanttModal } from './components/GanttModal';
import { DAGModal } from './components/DAGModal';
import { JobLineagePanel } from './components/JobLineagePanel';
import { RunningJobsPanel } from './components/RunningJobsPanel';
import { ProjectSelector } from './components/ProjectSelector';
import { SettingsModal } from './components/SettingsModal';
import { KnowledgeBaseModal } from './components/KnowledgeBaseModal';
import { EyeModal } from './components/EyeModal';
import { SlackModal } from './components/SlackModal';
import { GitModal } from './components/GitModal';
import { WorktreesSidebar } from './components/WorktreesSidebar';
import { WorktreeDetail } from './components/WorktreeDetail';
import { useSocket } from './hooks/useSocket';
import { useAgents } from './hooks/useAgents';
import { useJobs } from './hooks/useJobs';
import { useLocks } from './hooks/useLocks';
import { useProjects } from './hooks/useProjects';
import { useToasts } from './hooks/useToasts';
import { ToastFeed } from './components/ToastFeed';
import socket from './socket';
import type { AgentWithJob, AgentOutput, CreateJobRequest, Job, Template, BatchTemplate, Worktree, Repo } from '@shared/types';

export default function App() {
  const { agents, setInitial: setInitialAgents, addAgent, updateAgent } = useAgents();
  const { jobs, setInitial: setInitialJobs, addJob, updateJob } = useJobs();
  const { locks, setInitial: setInitialLocks, addLock, removeLock } = useLocks();
  const { projects, setInitial: setInitialProjects, addProject, updateProject, removeProject } = useProjects();
  const { toasts, dismiss: dismissToast } = useToasts();
  const [templates, setTemplates] = useState<Template[]>([]);

  const [selectedAgent, setSelectedAgent] = useState<AgentWithJob | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showGantt, setShowGantt] = useState(false);
  const [showDag, setShowDag] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showBatchTemplates, setShowBatchTemplates] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const [showEye, setShowEye] = useState(false);
  const [showSlack, setShowSlack] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [archivedJobs, setArchivedJobs] = useState<Job[]>([]);
  const [leftTab, setLeftTab] = useState<'feed' | 'lineage' | 'worktrees' | 'locks'>('feed');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);

  const [username, setUsername] = useState<string | null>(null);

  const [todayClaudeCost, setTodayClaudeCost] = useState<number | null>(null);
  const [todayCodexCost, setTodayCodexCost] = useState<number | null>(null);
  const [costAutoUpdate, setCostAutoUpdate] = useState(false);
  const fetchingCost = useRef(false);

  // Fetch current user
  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.username) setUsername(data.username);
    }).catch(() => {});
  }, []);

  // Fetch worktrees and repos periodically for job→worktree mapping
  useEffect(() => {
    const fetchWorktreesAndRepos = () => {
      fetch('/api/worktrees')
        .then(r => r.ok ? r.json() : [])
        .then((data: Worktree[]) => setWorktrees(data))
        .catch(() => {});
      fetch('/api/repos')
        .then(r => r.ok ? r.json() : [])
        .then((data: Repo[]) => setRepos(data))
        .catch(() => {});
    };
    fetchWorktreesAndRepos();
    const id = setInterval(fetchWorktreesAndRepos, 10_000);
    return () => clearInterval(id);
  }, []);

  const worktreesByJobId = useMemo(() => {
    const map = new Map<string, Worktree>();
    for (const wt of worktrees) {
      map.set(wt.job_id, wt);
    }
    return map;
  }, [worktrees]);

  const worktreesByPath = useMemo(() => {
    const map = new Map<string, Worktree>();
    for (const wt of worktrees) {
      map.set(wt.path, wt);
    }
    return map;
  }, [worktrees]);

  const repoById = useMemo(() => {
    const map = new Map<string, Repo>();
    for (const r of repos) {
      map.set(r.id, r);
    }
    return map;
  }, [repos]);

  // Track when PTY data was last received per agent (for idle detection)
  const lastPtyActivity = useRef<Map<string, number>>(new Map());
  const [ptyIdleAgents, setPtyIdleAgents] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handlePtyData = ({ agent_id }: { agent_id: string }) => {
      lastPtyActivity.current.set(agent_id, Date.now());
    };
    socket.on('pty:data', handlePtyData);
    return () => { socket.off('pty:data', handlePtyData); };
  }, []);

  // Poll every second to compute which interactive running agents are idle (no pty output for 3s)
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const idleSet = new Set<string>();
      for (const agent of agents) {
        if (agent.status === 'running' && agent.job.is_interactive) {
          const last = lastPtyActivity.current.get(agent.id);
          if (last !== undefined && now - last > 3000) {
            idleSet.add(agent.id);
          }
        }
      }
      setPtyIdleAgents(prev => {
        // Only update if the set contents changed
        if (prev.size === idleSet.size && [...idleSet].every(id => prev.has(id))) return prev;
        return idleSet;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [agents]);

  const fetchTodayCost = useCallback(async () => {
    if (fetchingCost.current) return;
    fetchingCost.current = true;
    try {
      const d = new Date();
      const since = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const res = await fetch(`/api/usage?since=${since}`);
      if (!res.ok) return;
      const data = await res.json();
      const claudeCost = data.totals?.totalCost ?? data.daily?.[0]?.totalCost ?? null;
      const codexCost = data.codex?.totals?.costUSD ?? data.codex?.daily?.[0]?.costUSD ?? null;
      setTodayClaudeCost(claudeCost);
      setTodayCodexCost(codexCost);
    } catch {
      // ignore — don't show broken state
    } finally {
      fetchingCost.current = false;
    }
  }, []);

  // When an agent updates, sync the selected agent if it's open; refresh cost when one finishes.
  // Also sync jobs state from the embedded job, since job:update events can be missed when
  // agent events arrive out-of-order or a transition happens entirely within the agent path.
  const handleAgentUpdate = useCallback((agent: AgentWithJob) => {
    updateAgent(agent);
    updateJob(agent.job);
    setSelectedAgent(prev => prev?.id === agent.id ? agent : prev);
    if (costAutoUpdate && (agent.status === 'done' || agent.status === 'failed')) {
      fetchTodayCost();
    }
  }, [updateAgent, updateJob, fetchTodayCost, costAutoUpdate]);

  const handleAgentNew = useCallback((agent: AgentWithJob) => {
    addAgent(agent);
    updateJob(agent.job);
  }, [addAgent, updateJob]);

  useSocket({
    onSnapshot: (snapshot) => {
      setInitialJobs(snapshot.jobs);
      setInitialAgents(snapshot.agents);
      setInitialLocks(snapshot.locks);
      setTemplates(snapshot.templates ?? []);
      setInitialProjects(snapshot.projects ?? []);
    },
    onAgentNew: handleAgentNew,
    onAgentUpdate: handleAgentUpdate,
    onAgentOutput: (_agentId: string, _line: AgentOutput) => {
      // Output is rendered live in AgentTerminal via socket listener
    },
    onQuestionNew: (question) => {
      // Question state is on the agent; update will come via agent:update
    },
    onQuestionAnswered: (question) => {
      // Same — agent update will follow
    },
    onLockAcquired: addLock,
    onLockReleased: (lockId) => removeLock(lockId),
    onJobNew: addJob,
    onJobUpdate: updateJob,
  });

  // Fetch on mount, then every 60s (if auto-update enabled)
  useEffect(() => {
    fetchTodayCost();
    if (!costAutoUpdate) return;
    const id = setInterval(fetchTodayCost, 60_000);
    return () => clearInterval(id);
  }, [fetchTodayCost, costAutoUpdate]);

  // ─── Load archived jobs when the archived view is active ──────────────────
  useEffect(() => {
    if (activeProjectId !== '__archived__') return;
    fetch('/api/jobs?archived=1')
      .then(r => r.ok ? r.json() : [])
      .then((data: Job[]) => setArchivedJobs(data))
      .catch(() => {});
  }, [activeProjectId]);

  // ─── Project-scoped filtering ──────────────────────────────────────────────
  const filteredJobs = useMemo(() => {
    if (activeProjectId === '__archived__') return archivedJobs;
    const activeJobs = jobs.filter(j => !j.archived_at);
    if (activeProjectId) return activeJobs.filter(j => j.project_id === activeProjectId);
    return activeJobs.filter(j => !j.project_id);
  }, [jobs, activeProjectId, archivedJobs]);

  const filteredJobIds = useMemo(() => new Set(filteredJobs.map(j => j.id)), [filteredJobs]);

  const filteredAgents = useMemo(() => {
    return agents.filter(a => filteredJobIds.has(a.job_id));
  }, [agents, filteredJobIds]);

  const activeProjectName = useMemo(() => {
    if (!activeProjectId) return null;
    if (activeProjectId === '__archived__') return 'Archived';
    return projects.find(p => p.id === activeProjectId)?.name ?? null;
  }, [projects, activeProjectId]);

  const handleCreateProject = useCallback(async (name: string, description: string) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || undefined }),
      });
      if (!res.ok) return;
      const project = await res.json();
      addProject(project);
      setActiveProjectId(project.id);
    } catch { /* ignore */ }
  }, [addProject]);

  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      removeProject(id);
      if (activeProjectId === id) setActiveProjectId(null);
    } catch { /* ignore */ }
  }, [removeProject, activeProjectId]);

  const handleRenameProject = useCallback(async (id: string, newName: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) return;
      const updated = await res.json();
      updateProject(updated);
    } catch { /* ignore */ }
  }, [updateProject]);

  const handleRenameJob = useCallback(async (jobId: string, newTitle: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) return;
      const updated = await res.json();
      updateJob(updated);
      // Keep selectedAgent in sync
      setSelectedAgent(prev => prev && prev.job.id === jobId ? { ...prev, job: updated } : prev);
    } catch { /* ignore */ }
  }, [updateJob]);

  const handleSubmitJob = useCallback(async (req: CreateJobRequest) => {
    const payload = activeProjectId ? { ...req, projectId: activeProjectId } : req;
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Failed to create job');
    }
  }, [activeProjectId]);

  const handleSelectAgent = useCallback((agent: AgentWithJob) => {
    setSelectedAgent(agent);
    const canonicalJob = jobs.find(j => j.id === agent.job_id);
    setActiveProjectId(canonicalJob?.project_id ?? agent.job.project_id ?? null);
    setDrawerOpen(false);
  }, [jobs]);

  const handleSelectJob = useCallback((job: Job) => {
    const agent = agents.find(a => a.job_id === job.id);
    if (agent) {
      setSelectedAgent(agent);
    }
    setActiveProjectId(job.project_id ?? null);
    setDrawerOpen(false);
  }, [agents]);

  const handleCancelJob = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
  }, []);

  const handleRunJobNow = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}/run-now`, { method: 'POST' });
  }, []);

  const handleArchiveJob = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}/archive`, { method: 'POST' });
  }, []);

  const handleArchiveAll = useCallback(async (jobs: Job[]) => {
    await Promise.all(jobs.map(j => fetch(`/api/jobs/${j.id}/archive`, { method: 'POST' })));
  }, []);

  const handleCloseTerminal = useCallback(() => {
    setSelectedAgent(null);
    setLeftTab('feed');
  }, []);

  return (
    <div className="app">
      <Header onNewJob={() => setShowJobForm(true)} onTemplates={() => setShowTemplates(true)} onBatchTemplates={() => setShowBatchTemplates(true)} onUsage={() => setShowUsage(true)} onSearch={() => setShowSearch(true)} onTimeline={() => setShowGantt(true)} onDag={() => setShowDag(true)} onProjects={() => setShowProjects(true)} onSettings={() => setShowSettings(true)}onKnowledgeBase={() => setShowKnowledgeBase(true)} onEye={() => setShowEye(true)} onSlack={() => setShowSlack(true)} onGit={() => setShowGit(true)} onHome={() => { setSelectedAgent(null); setActiveProjectId(null); setShowJobForm(false); setShowTemplates(false); setShowBatchTemplates(false); setShowUsage(false); setShowSearch(false); setShowGantt(false); setShowDag(false); setShowProjects(false); setShowSettings(false); setShowKnowledgeBase(false); setShowEye(false); setShowSlack(false); setShowGit(false); }} currentProjectName={activeProjectName} onClearProject={() => setActiveProjectId(null)} todayClaudeCost={todayClaudeCost ?? undefined} todayCodexCost={todayCodexCost ?? undefined} costAutoUpdate={costAutoUpdate} onToggleCostAutoUpdate={() => setCostAutoUpdate(v => !v)} onDrawerToggle={() => setDrawerOpen(v => !v)} onHeaderMenuToggle={() => setHeaderMenuOpen(v => !v)} headerMenuOpen={headerMenuOpen} username={username} />

      <div className={`drawer-backdrop${drawerOpen ? ' drawer-backdrop-visible' : ''}`} onClick={() => setDrawerOpen(false)} />
      {headerMenuOpen && <div className="header-menu-backdrop" onClick={() => setHeaderMenuOpen(false)} />}

      <div className="main-layout">
        <div className={`left-sidebar-stack ${(leftTab === 'lineage' && selectedAgent) || leftTab === 'worktrees' ? '' : 'left-sidebar-stack--narrow'}${drawerOpen ? ' drawer-open' : ''}`}>
          <div className="left-sidebar-tabs">
            <button
              className={`left-sidebar-tab ${leftTab === 'feed' ? 'left-sidebar-tab--active' : ''}`}
              onClick={() => setLeftTab('feed')}
            >Feed</button>
            {selectedAgent && (
              <button
                className={`left-sidebar-tab ${leftTab === 'lineage' ? 'left-sidebar-tab--active' : ''}`}
                onClick={() => setLeftTab('lineage')}
              >Lineage</button>
            )}
            <button
              className={`left-sidebar-tab ${leftTab === 'worktrees' ? 'left-sidebar-tab--active' : ''}`}
              onClick={() => setLeftTab('worktrees')}
            >Worktrees</button>
            <button
              className={`left-sidebar-tab ${leftTab === 'locks' ? 'left-sidebar-tab--active' : ''}`}
              onClick={() => setLeftTab('locks')}
            >Locks</button>
          </div>
          {leftTab === 'worktrees' ? (
            <WorktreesSidebar
              selectedWorktreeId={selectedWorktree?.id}
              onSelectWorktree={(wt) => { setSelectedAgent(null); setSelectedWorktree(wt); }}
            />
          ) : leftTab === 'locks' ? (
            <div className="sidebar-locks-container">
              <FileLockMap locks={locks} />
            </div>
          ) : leftTab === 'lineage' && selectedAgent ? (
            <JobLineagePanel
              selectedAgent={selectedAgent}
              allAgents={agents}
              onSelectAgent={handleSelectAgent}
            />
          ) : (
            <WorkQueueSidebar jobs={jobs} projects={projects} repos={repos} worktreesByJobId={worktreesByJobId} onSelectJob={handleSelectJob} onCancelJob={handleCancelJob} onRunJobNow={handleRunJobNow} onArchiveJob={handleArchiveJob} />
          )}
          {leftTab !== 'worktrees' && leftTab !== 'locks' && (
            <RunningJobsPanel
              agents={agents}
              projects={projects}
              onSelectAgent={handleSelectAgent}
              ptyIdleAgentIds={ptyIdleAgents}
            />
          )}
        </div>

        <main className={`agent-main ${selectedAgent ? 'agent-main-split' : ''} ${leftTab === 'locks' ? 'agent-main-locks' : ''}`}>
          <div className={`mobile-worktrees-main ${leftTab === 'worktrees' ? 'mobile-worktrees-main--active' : ''}`}>
            <WorktreesSidebar
              selectedWorktreeId={selectedWorktree?.id}
              onSelectWorktree={(wt) => { setSelectedAgent(null); setSelectedWorktree(wt); }}
            />
          </div>
          <div className={`mobile-locks-main ${leftTab === 'locks' ? 'mobile-locks-main--active' : ''}`}>
            <FileLockMap locks={locks} />
          </div>
          <div className={`agent-grid-wrapper ${leftTab === 'worktrees' ? 'agent-grid-wrapper--hidden-mobile' : ''} ${leftTab === 'locks' ? 'agent-grid-wrapper--hidden-locks' : ''}`}>
            <AgentGrid agents={filteredAgents} queuedJobs={filteredJobs.filter(j => j.status === 'queued')} onSelectAgent={handleSelectAgent} onArchiveJob={handleArchiveJob} onArchiveAll={handleArchiveAll} templates={templates} selectedAgentId={selectedAgent?.id ?? null} ptyIdleAgentIds={ptyIdleAgents} worktreesByJobId={worktreesByJobId} worktreesByPath={worktreesByPath} repoById={repoById} />
          </div>
        </main>

        {selectedAgent ? (
          <AgentTerminal
            agent={selectedAgent}
            onClose={handleCloseTerminal}
            onContinued={handleSelectAgent}
            onRenameJob={handleRenameJob}
          />
        ) : leftTab === 'worktrees' && selectedWorktree ? (
          <WorktreeDetail
            key={selectedWorktree.id}
            worktree={selectedWorktree}
            onDeleted={() => setSelectedWorktree(null)}
            onClose={() => setSelectedWorktree(null)}
          />
        ) : null}
      </div>

      {showEye && (
        <EyeModal onClose={() => setShowEye(false)} />
      )}

      {showJobForm && (
        <JobForm
          onSubmit={handleSubmitJob}
          onClose={() => setShowJobForm(false)}
          availableJobs={jobs}
        />
      )}

      {showTemplates && (
        <TemplateManager onClose={() => setShowTemplates(false)} />
      )}

      {showBatchTemplates && (
        <BatchTemplateManager
          onClose={() => setShowBatchTemplates(false)}
          onRun={(project) => {
            setShowBatchTemplates(false);
            addProject(project);
            setActiveProjectId(project.id);
          }}
        />
      )}

      {showUsage && (
        <UsageModal onClose={() => setShowUsage(false)} />
      )}

      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onSelectAgent={(agentId) => {
            const agent = agents.find(a => a.id === agentId);
            if (agent) { handleSelectAgent(agent); }
            setShowSearch(false);
          }}
        />
      )}

      {showGantt && (
        <GanttModal
          jobs={filteredJobs}
          agents={filteredAgents}
          onClose={() => setShowGantt(false)}
          onSelectAgent={(agent) => {
            handleSelectAgent(agent);
            setShowGantt(false);
          }}
        />
      )}

      {showDag && (
        <DAGModal
          jobs={filteredJobs}
          agents={filteredAgents}
          onClose={() => setShowDag(false)}
          onSelectAgent={(agent) => {
            handleSelectAgent(agent);
            setShowDag(false);
          }}
        />
      )}

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}

      {showKnowledgeBase && (
        <KnowledgeBaseModal onClose={() => setShowKnowledgeBase(false)} />
      )}


      {showSlack && (
        <SlackModal onClose={() => setShowSlack(false)} />
      )}

      {showGit && (
        <GitModal onClose={() => setShowGit(false)} />
      )}

      {showProjects && (
        <ProjectSelector
          projects={projects}
          activeProjectId={activeProjectId}
          onSelect={setActiveProjectId}
          onCreate={handleCreateProject}
          onDelete={handleDeleteProject}
          onRename={handleRenameProject}
          onClose={() => setShowProjects(false)}
        />
      )}

      {/* Mobile bottom tab bar */}
      <nav className="mobile-bottom-tabs">
        <button
          className={`mobile-bottom-tab ${leftTab === 'feed' || leftTab === 'lineage' ? 'mobile-bottom-tab--active' : ''}`}
          onClick={() => { setLeftTab('feed'); setSelectedWorktree(null); }}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>
          Agents
        </button>
        <button
          className={`mobile-bottom-tab ${leftTab === 'worktrees' ? 'mobile-bottom-tab--active' : ''}`}
          onClick={() => setLeftTab('worktrees')}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1H8a3 3 0 00-3 3v1.5a1.5 1.5 0 01-3 0V6z" clipRule="evenodd"/><path d="M6 12a2 2 0 012-2h8a2 2 0 012 2v2a2 2 0 01-2 2H2h2a2 2 0 002-2v-2z"/></svg>
          Worktrees
        </button>
        <button
          className={`mobile-bottom-tab ${leftTab === 'locks' ? 'mobile-bottom-tab--active' : ''}`}
          onClick={() => setLeftTab('locks')}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/></svg>
          Locks
        </button>
      </nav>

      <ToastFeed
        toasts={toasts}
        dismiss={dismissToast}
        onSelectAgent={(agentId) => {
          const agent = agents.find(a => a.id === agentId);
          if (agent) handleSelectAgent(agent);
        }}
      />
    </div>
  );
}
