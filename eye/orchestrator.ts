import type { CreateJobRequest, CreateDebateRequest, CreateDebateResponse, Repo, Worktree } from '../src/shared/types.js';

export interface OrchestratorClient {
  createJob(req: CreateJobRequest): Promise<{ id: string; title: string } | null>;
  createDebate(req: CreateDebateRequest): Promise<CreateDebateResponse | null>;
  getRepoByName(name: string): Promise<Repo | null>;
  getWorktreeByBranch(branch: string): Promise<Worktree | null>;
  createWorktree(branch: string, repoDir: string, trackExisting?: boolean): Promise<Worktree | null>;
}

export function createOrchestratorClient(baseUrl: string): OrchestratorClient {
  return {
    async createJob(req: CreateJobRequest): Promise<{ id: string; title: string } | null> {
      try {
        const res = await fetch(`${baseUrl}/api/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (!res.ok) {
          console.error(`[eye] orchestrator POST /api/jobs failed: ${res.status} ${await res.text()}`);
          return null;
        }
        const job = await res.json() as { id: string; title: string };
        console.log(`[eye] created job: ${job.title} (${job.id})`);
        return job;
      } catch (err) {
        console.error('[eye] orchestrator unreachable:', err);
        return null;
      }
    },

    async createDebate(req: CreateDebateRequest): Promise<CreateDebateResponse | null> {
      try {
        const res = await fetch(`${baseUrl}/api/debates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (!res.ok) {
          console.error(`[eye] orchestrator POST /api/debates failed: ${res.status} ${await res.text()}`);
          return null;
        }
        const data = await res.json() as CreateDebateResponse;
        console.log(`[eye] created debate: ${data.debate.title} (${data.debate.id})`);
        return data;
      } catch (err) {
        console.error('[eye] orchestrator unreachable:', err);
        return null;
      }
    },

    async getRepoByName(name: string): Promise<Repo | null> {
      try {
        const res = await fetch(`${baseUrl}/api/repos/by-name/${encodeURIComponent(name)}`);
        if (res.status === 404) return null;
        if (!res.ok) {
          console.error(`[eye] orchestrator GET /api/repos/by-name failed: ${res.status}`);
          return null;
        }
        return await res.json() as Repo;
      } catch (err) {
        console.error('[eye] orchestrator unreachable:', err);
        return null;
      }
    },

    async getWorktreeByBranch(branch: string): Promise<Worktree | null> {
      try {
        const res = await fetch(`${baseUrl}/api/worktrees/by-branch/${encodeURIComponent(branch)}`);
        if (res.status === 404) return null;
        if (!res.ok) {
          console.error(`[eye] orchestrator GET /api/worktrees/by-branch failed: ${res.status}`);
          return null;
        }
        return await res.json() as Worktree;
      } catch (err) {
        console.error('[eye] orchestrator unreachable:', err);
        return null;
      }
    },

    async createWorktree(branch: string, repoDir: string, trackExisting = true): Promise<Worktree | null> {
      try {
        const res = await fetch(`${baseUrl}/api/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch, repoDir, trackExisting }),
        });
        if (!res.ok) {
          console.error(`[eye] orchestrator POST /api/worktrees failed: ${res.status} ${await res.text()}`);
          return null;
        }
        const wt = await res.json() as Worktree;
        console.log(`[eye] created worktree: ${wt.path} (branch: ${wt.branch})`);
        return wt;
      } catch (err) {
        console.error('[eye] orchestrator unreachable:', err);
        return null;
      }
    },
  };
}
