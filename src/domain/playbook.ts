import type { WorkItem } from './types.ts';

export type AgentRole = WorkItem['role'];

/** 角色 playbook 的内容形状；版本化存储后仍由角色装载使用。 */
export interface PlaybookContent {
  role: AgentRole;
  name: string;
  objective: string;
  steps: string[];
  boundaries: string[];
}

export type PlaybookStatus = 'canary' | 'active' | 'retired';

export type ProposalStatus = 'proposed' | 'evaluated' | 'promoted' | 'rejected';

export interface PlaybookMetrics {
  passRate: number;
  passed: number;
  total: number;
  /** 每条黄金任务的通过情况，用于检测相对基线的新增回归。 */
  tasks: Record<string, boolean>;
  tokens?: number;
  evaluatedAt: string;
}

export interface PlaybookVersion {
  id: string;
  role: AgentRole;
  version: number;
  content: PlaybookContent;
  status: PlaybookStatus;
  /** 灰度比例 0-100；100 表示全量。 */
  canaryPercent: number;
  sourceProposalId?: string;
  metrics?: PlaybookMetrics;
  createdAt: string;
  activatedAt?: string;
  retiredAt?: string;
}

export interface GoldenTask {
  id: string;
  role: AgentRole;
  title: string;
  prompt: string;
  criteria: string[];
  createdAt: string;
}

export interface EvaluationResult {
  taskId: string;
  passed: boolean;
  tokens?: number;
  durationMs?: number;
  notes?: string;
}

export interface PlaybookEvaluation {
  proposalId: string;
  results: EvaluationResult[];
  passed: number;
  total: number;
  passRate: number;
  minPassRate: number;
  minTasks: number;
  /** 基线通过、候选失败的任务。 */
  regressions: string[];
  evaluatedAt: string;
}

export interface PlaybookProposal {
  id: string;
  role: AgentRole;
  baseVersionId?: string;
  baseVersion?: number;
  content: PlaybookContent;
  rationale: string;
  sourceGoalId?: string;
  createdBy: string;
  status: ProposalStatus;
  evaluation?: PlaybookEvaluation;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
}