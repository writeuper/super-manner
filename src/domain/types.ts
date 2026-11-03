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