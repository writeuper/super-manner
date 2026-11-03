import type { Action, Role } from './actions.ts';

export type { Action } from './actions.ts';

export type AutonomyLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export type GoalStatus =
  | 'draft'
  | 'pending_confirmation'
  | 'executing'
  | 'verifying'
  | 'awaiting_acceptance'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type PlanStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export type GrantStatus = 'active' | 'revoked';

export type EscalationStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ResourceRef {
  repo?: string;
  branch?: string;
  path?: string;
  host?: string;
  key?: string;
  prNumber?: number;
  tokens?: number;
}

export interface GrantScope {
  repos: string[];
  branches?: string[];
  paths?: string[];
  hosts?: string[];
  secretKeys?: string[];
}

export interface GrantConstraints {
  expiresAt?: string;
  maxTokens?: number;
  maxMergeCount?: number;
}

export interface GrantSpec {
  subject?: string;
  actions: Action[];
  scope: GrantScope;
  constraints?: GrantConstraints;
}

export interface WorkItem {
  id: string;
  title: string;
  role: Exclude<Role, 'architect' | 'observer'>;
  dependsOn: string[];
  dod: string[];
  budgetTokens: number;
  grant: GrantSpec;
}

export interface Plan {
  id: string;
  goalId: string;
  version: number;
  status: PlanStatus;
  workItems: WorkItem[];
  totalBudgetTokens: number;
  risks: string[];
  pendingDecisions: string[];
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  rejectionReason?: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  repo: string;
  baseBranch: string;
  acceptance: string[];
  constraints: string[];
  budgetTokens: number;
  autonomy: AutonomyLevel;
  status: GoalStatus;
  /** 暂停前的状态，用于恢复到原来的阶段；非 paused 时为空。 */
  pausedFrom?: GoalStatus;
  missing: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Grant {
  id: string;
  goalId: string;
  workItemId?: string;
  subject: string;
  role: Role;
  actions: Action[];
  scope: GrantScope;
  constraints: GrantConstraints;
  parentGrantId?: string;
  issuerId: string;
  status: GrantStatus;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

export interface Escalation {
  id: string;
  goalId: string;
  subject: string;
  action: Action;
  resource: ResourceRef;
  reason: string;
  impact: string;
  options: string[];
  recommendation: string;
  status: EscalationStatus;
  requiresSecond: boolean;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
}

export interface Approval {
  id: string;
  escalationId: string;
  goalId: string;
  subject: string;
  action: Action;
  resourceKey: string;
  createdAt: string;
  usedAt?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  type: string;
  goalId?: string;
  subject?: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface AuthorizationRequest {
  action: Action;
  subject: string;
  goalId: string;
  resource: ResourceRef;
}

export type AuthDecision = 'allow' | 'deny' | 'escalate';

export interface AuthResult {
  decision: AuthDecision;
  reason: string;
  grantId?: string;
}

export type WorkspaceStatus = 'active' | 'removed';

/**
 * 工作项隔离出来的独立 worktree。
 *
 * repo 是逻辑仓库名（owner/repo），repoDir 是本地克隆路径；
 * branch 以 feature/sm-* 命名，天然落在 S1 工作项授权的分支范围内。
 */
export interface Workspace {
  id: string;
  goalId: string;
  workItemId: string;
  repo: string;
  repoDir: string;
  baseBranch: string;
  branch: string;
  path: string;
  status: WorkspaceStatus;
  createdAt: string;
  removedAt?: string;
}

/** 检查点只记录已经完成的写操作，用于暂停恢复时避免重复执行。 */
export type CheckpointKind = 'builder_run' | 'commit' | 'push';

export interface Checkpoint {
  id: string;
  goalId: string;
  workItemId: string;
  kind: CheckpointKind;
  runId?: string;
  /** 对应的审计事件 id；判断检查点之后是否出现返工或不通过。 */
  auditId?: string;
  payload: unknown;
  createdAt: string;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  repo: string;
  baseBranch?: string;
  acceptance: string[];
  constraints?: string[];
  budgetTokens: number;
  autonomy?: AutonomyLevel;
}