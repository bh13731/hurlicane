import type { CreateJobRequest, CreateDebateRequest, CreateDebateResponse, Repo, Worktree } from '../../shared/types.js';

export interface TemplateFilter {
  field: string;
  op: 'eq' | 'neq';
  value: string;
}

export interface DebateBindingConfig {
  claudeModel?: string;
  codexModel?: string;
  maxRounds?: number;
  postActionVerification?: boolean;
  postActionPrompt?: string;
  postActionRole?: 'claude' | 'codex';
  completionChecks?: string[];
}

export interface TemplateBinding {
  templateId: string;
  filters: TemplateFilter[];
  /** 'job' = always simple job, 'debate' = always debate, 'auto' = complexity heuristic (default) */
  mode?: 'job' | 'debate' | 'auto';
  /** Debate configuration — used when mode is 'debate' or auto evaluates to debate */
  debateConfig?: DebateBindingConfig;
}

export interface EyePrompts {
  eventTemplates: Record<string, TemplateBinding[]>;
  disabledEvents: string[];
  botName: string;
}

export interface EyeConfig {
  webhookSecret: string;
  author: string;
}

export interface OrchestratorClient {
  createJob(req: CreateJobRequest): Promise<{ id: string; title: string } | null>;
  createDebate(req: CreateDebateRequest): Promise<CreateDebateResponse | null>;
  getRepoByName(name: string): Promise<Repo | null>;
  getWorktreeByBranch(branch: string): Promise<Worktree | null>;
  createWorktree(branch: string, repoId: string, trackExisting?: boolean): Promise<Worktree | null>;
  cleanupBranch(branch: string, merged?: boolean): Promise<{ found: boolean; cancelledJobs: number } | null>;
  getPrompts(): Promise<EyePrompts>;
}
