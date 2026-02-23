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
import { DebateForm } from './components/DebateForm';
import { useSocket } from './hooks/useSocket';
import { useAgents } from './hooks/useAgents';
import { useJobs } from './hooks/useJobs';
import { useLocks } from './hooks/useLocks';
import { useProjects } from './hooks/useProjects';
import { useDebates } from './hooks/useDebates';
import { useToasts } from './hooks/useToasts';
import { ToastFeed } from './components/ToastFeed';
import type { AgentWithJob, AgentOutput, CreateJobRequest, CreateDebateRequest, Job, Template, BatchTemplate } from '@shared/types';

export default function App() {
  const { agents, setInitial: setInitialAgents, addAgent, updateAgent } = useAgents();
  const { jobs, setInitial: setInitialJobs, addJob, updateJob } = useJobs();
  const { locks, setInitial: setInitialLocks, addLock, removeLock } = useLocks();
  const { projects, setInitial: setInitialProjects, addProject, updateProject, removeProject } = useProjects();
  const { debates, setInitial: setInitialDebates, addDebate, updateDebate: updateDebateState } = useDebates();
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
  const [showDebateForm, setShowDebateForm] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [todayClaudeCost, setTodayClaudeCost] = useState<number | null>(null);
  const [todayCodexCost, setTodayCodexCost] = useState<number | null>(null);
  const fetchingCost = useRef(false);

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

  // When an agent updates, sync the selected agent if it's open; refresh cost when one finishes
  const handleAgentUpdate = useCallback((agent: AgentWithJob) => {
    updateAgent(agent);
    setSelectedAgent(prev => prev?.id === agent.id ? agent : prev);
    if (agent.status === 'done' || agent.status === 'failed') {
      fetchTodayCost();
    }
  }, [updateAgent, fetchTodayCost]);

  useSocket({
    onSnapshot: (snapshot) => {
      setInitialJobs(snapshot.jobs);
      setInitialAgents(snapshot.agents);
      setInitialLocks(snapshot.locks);
      setTemplates(snapshot.templates ?? []);
      setInitialProjects(snapshot.projects ?? []);
      setInitialDebates(snapshot.debates ?? []);
    },
    onAgentNew: addAgent,
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
    onDebateNew: addDebate,
    onDebateUpdate: updateDebateState,
  });

  // Fetch on mount, then every 60s
  useEffect(() => {
    fetchTodayCost();
    const id = setInterval(fetchTodayCost, 60_000);
    return () => clearInterval(id);
  }, [fetchTodayCost]);

  // ─── Project-scoped filtering ──────────────────────────────────────────────
  const filteredJobs = useMemo(() => {
    if (activeProjectId) return jobs.filter(j => j.project_id === activeProjectId);
    return jobs.filter(j => !j.project_id);
  }, [jobs, activeProjectId]);

  const filteredJobIds = useMemo(() => new Set(filteredJobs.map(j => j.id)), [filteredJobs]);

  const filteredAgents = useMemo(() => {
    return agents.filter(a => filteredJobIds.has(a.job_id));
  }, [agents, filteredJobIds]);

  const activeProjectName = useMemo(() => {
    if (!activeProjectId) return null;
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

  const handleSubmitDebate = useCallback(async (req: CreateDebateRequest) => {
    const res = await fetch('/api/debates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Failed to create debate');
    }
    const data = await res.json();
    // Add the project created for this debate and switch to it
    addProject(data.project);
    setActiveProjectId(data.project.id);
  }, [addProject]);

  const handleSelectAgent = useCallback((agent: AgentWithJob) => {
    setSelectedAgent(agent);
  }, []);

  const handleSelectJob = useCallback((job: Job) => {
    const agent = agents.find(a => a.job_id === job.id);
    if (agent) setSelectedAgent(agent);
  }, [agents]);

  const handleCloseTerminal = useCallback(() => {
    setSelectedAgent(null);
  }, []);

  return (
    <div className="app">
      <Header onNewJob={() => setShowJobForm(true)} onTemplates={() => setShowTemplates(true)} onBatchTemplates={() => setShowBatchTemplates(true)} onUsage={() => setShowUsage(true)} onSearch={() => setShowSearch(true)} onTimeline={() => setShowGantt(true)} onDag={() => setShowDag(true)} onProjects={() => setShowProjects(true)} onSettings={() => setShowSettings(true)} onDebate={() => setShowDebateForm(true)} onHome={() => { setSelectedAgent(null); setShowJobForm(false); setShowTemplates(false); setShowBatchTemplates(false); setShowUsage(false); setShowSearch(false); setShowGantt(false); setShowDag(false); setShowProjects(false); setShowSettings(false); setShowDebateForm(false); }} currentProjectName={activeProjectName} onClearProject={() => setActiveProjectId(null)} todayClaudeCost={todayClaudeCost ?? undefined} todayCodexCost={todayCodexCost ?? undefined} />

      <div className="main-layout">
        {selectedAgent ? (
          <div className="left-sidebar-stack">
            <JobLineagePanel
              selectedAgent={selectedAgent}
              allAgents={agents}
              onSelectAgent={handleSelectAgent}
            />
            <RunningJobsPanel
              agents={agents}
              projects={projects}
              onSelectAgent={handleSelectAgent}
            />
          </div>
        ) : (
          <div className="left-sidebar-stack left-sidebar-stack--narrow">
            <WorkQueueSidebar jobs={filteredJobs} onSelectJob={handleSelectJob} />
            <RunningJobsPanel
              agents={agents}
              projects={projects}
              onSelectAgent={handleSelectAgent}
            />
          </div>
        )}

        <main className={`agent-main ${selectedAgent ? 'agent-main-split' : ''}`}>
          <AgentGrid agents={filteredAgents} queuedJobs={filteredJobs.filter(j => j.status === 'queued')} onSelectAgent={handleSelectAgent} templates={templates} selectedAgentId={selectedAgent?.id ?? null} />
        </main>

        {selectedAgent ? (
          <AgentTerminal
            agent={selectedAgent}
            onClose={handleCloseTerminal}
            onContinued={handleSelectAgent}
            onRenameJob={handleRenameJob}
          />
        ) : (
          <FileLockMap locks={locks} />
        )}
      </div>

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

      {showDebateForm && (
        <DebateForm
          onSubmit={handleSubmitDebate}
          onClose={() => setShowDebateForm(false)}
        />
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
