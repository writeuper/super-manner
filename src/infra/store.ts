import type { DatabaseSync } from 'node:sqlite';
import type {
  Approval,
  Escalation,
  EscalationStatus,
  Goal,
  Grant,
  Plan,
} from '../domain/types.ts';

type Row = Record<string, unknown>;

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---------- Goal ----------

function goalFromRow(row: Row): Goal {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    repo: String(row.repo),
    baseBranch: String(row.base_branch),
    acceptance: parse<string[]>(row.acceptance),
    constraints: parse<string[]>(row.constraints),
    budgetTokens: Number(row.budget_tokens),
    autonomy: String(row.autonomy) as Goal['autonomy'],
    status: String(row.status) as Goal['status'],
    missing: parse<string[]>(row.missing),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function insertGoal(db: DatabaseSync, goal: Goal): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, repo, base_branch, acceptance, constraints,
      budget_tokens, autonomy, status, missing, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    goal.id,
    goal.title,
    goal.description,
    goal.repo,
    goal.baseBranch,
    JSON.stringify(goal.acceptance),
    JSON.stringify(goal.constraints),
    goal.budgetTokens,
    goal.autonomy,
    goal.status,
    JSON.stringify(goal.missing),
    goal.createdAt,
    goal.updatedAt,
  );
}

export function updateGoal(db: DatabaseSync, goal: Goal): void {
  db.prepare(
    `UPDATE goals SET title = ?, description = ?, repo = ?, base_branch = ?, acceptance = ?,
      constraints = ?, budget_tokens = ?, autonomy = ?, status = ?, missing = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    goal.title,
    goal.description,
    goal.repo,
    goal.baseBranch,
    JSON.stringify(goal.acceptance),
    JSON.stringify(goal.constraints),
    goal.budgetTokens,
    goal.autonomy,
    goal.status,
    JSON.stringify(goal.missing),
    goal.updatedAt,
    goal.id,
  );
}

export function getGoal(db: DatabaseSync, id: string): Goal | undefined {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Row | undefined;
  return row ? goalFromRow(row) : undefined;
}

export function listGoals(db: DatabaseSync): Goal[] {
  return (db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as Row[]).map(goalFromRow);
}

// ---------- Plan ----------

function planFromRow(row: Row): Plan {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    version: Number(row.version),
    status: String(row.status) as Plan['status'],
    workItems: parse<Plan['workItems']>(row.work_items),
    totalBudgetTokens: Number(row.total_budget_tokens),
    risks: parse<string[]>(row.risks),
    pendingDecisions: parse<string[]>(row.pending_decisions),
    createdAt: String(row.created_at),
    decidedAt: optionalString(row.decided_at),
    decidedBy: optionalString(row.decided_by),
    rejectionReason: optionalString(row.rejection_reason),
  };
}

export function insertPlan(db: DatabaseSync, plan: Plan): void {
  db.prepare(
    `INSERT INTO plans (id, goal_id, version, status, work_items, total_budget_tokens,
      risks, pending_decisions, created_at, decided_at, decided_by, rejection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id,
    plan.goalId,
    plan.version,
    plan.status,
    JSON.stringify(plan.workItems),
    plan.totalBudgetTokens,
    JSON.stringify(plan.risks),
    JSON.stringify(plan.pendingDecisions),
    plan.createdAt,
    plan.decidedAt ?? null,
    plan.decidedBy ?? null,
    plan.rejectionReason ?? null,
  );
}

export function updatePlan(db: DatabaseSync, plan: Plan): void {
  db.prepare(
    `UPDATE plans SET status = ?, decided_at = ?, decided_by = ?, rejection_reason = ? WHERE id = ?`,
  ).run(
    plan.status,
    plan.decidedAt ?? null,
    plan.decidedBy ?? null,
    plan.rejectionReason ?? null,
    plan.id,
  );
}

export function getPlan(db: DatabaseSync, id: string): Plan | undefined {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
  return row ? planFromRow(row) : undefined;
}

export function listPlansForGoal(db: DatabaseSync, goalId: string): Plan[] {
  return (db.prepare('SELECT * FROM plans WHERE goal_id = ? ORDER BY version ASC').all(goalId) as Row[]).map(
    planFromRow,
  );
}

// ---------- Grant ----------

function grantFromRow(row: Row): Grant {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    workItemId: optionalString(row.work_item_id),
    subject: String(row.subject),
    role: String(row.role) as Grant['role'],
    actions: parse<Grant['actions']>(row.actions),
    scope: parse<Grant['scope']>(row.scope),
    constraints: parse<Grant['constraints']>(row.constraints),
    parentGrantId: optionalString(row.parent_grant_id),
    issuerId: String(row.issuer_id),
    status: String(row.status) as Grant['status'],
    createdAt: String(row.created_at),
    expiresAt: optionalString(row.expires_at),
    revokedAt: optionalString(row.revoked_at),
    revokeReason: optionalString(row.revoke_reason),
  };
}

export function insertGrants(db: DatabaseSync, grants: Grant[]): void {
  const statement = db.prepare(
    `INSERT INTO grants (id, goal_id, work_item_id, subject, role, actions, scope, constraints,
      parent_grant_id, issuer_id, status, created_at, expires_at, revoked_at, revoke_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  transaction(db, () => {
    for (const grant of grants) {
      statement.run(
        grant.id,
        grant.goalId,
        grant.workItemId ?? null,
        grant.subject,
        grant.role,
        JSON.stringify(grant.actions),
        JSON.stringify(grant.scope),
        JSON.stringify(grant.constraints),
        grant.parentGrantId ?? null,
        grant.issuerId,
        grant.status,
        grant.createdAt,
        grant.expiresAt ?? null,
        grant.revokedAt ?? null,
        grant.revokeReason ?? null,
      );
    }
  });
}

export function listGrantsForGoal(db: DatabaseSync, goalId: string): Grant[] {
  return (db.prepare('SELECT * FROM grants WHERE goal_id = ? ORDER BY created_at ASC').all(goalId) as Row[]).map(
    grantFromRow,
  );
}

export function listActiveGrantsForSubject(db: DatabaseSync, goalId: string, subject: string): Grant[] {
  return (
    db
      .prepare('SELECT * FROM grants WHERE goal_id = ? AND subject = ? AND status = ? ORDER BY created_at ASC')
      .all(goalId, subject, 'active') as Row[]
  ).map(grantFromRow);
}

export function revokeGrantsForGoal(db: DatabaseSync, goalId: string, at: string, reason: string): number {
  const result = db
    .prepare(
      `UPDATE grants SET status = 'revoked', revoked_at = ?, revoke_reason = ?
       WHERE goal_id = ? AND status = 'active'`,
    )
    .run(at, reason, goalId);
  return Number(result.changes);
}

// ---------- Escalation ----------

function escalationFromRow(row: Row): Escalation {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    subject: String(row.subject),
    action: String(row.action) as Escalation['action'],
    resource: parse<Escalation['resource']>(row.resource),
    reason: String(row.reason),
    impact: String(row.impact),
    options: parse<string[]>(row.options),
    recommendation: String(row.recommendation),
    status: String(row.status) as EscalationStatus,
    requiresSecond: Number(row.requires_second) === 1,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: optionalString(row.decided_at),
    decidedBy: optionalString(row.decided_by),
    decisionReason: optionalString(row.decision_reason),
  };
}

export function insertEscalation(db: DatabaseSync, escalation: Escalation): void {
  db.prepare(
    `INSERT INTO escalations (id, goal_id, subject, action, resource, reason, impact, options,
      recommendation, status, requires_second, created_at, expires_at, decided_at, decided_by, decision_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    escalation.id,
    escalation.goalId,
    escalation.subject,
    escalation.action,
    JSON.stringify(escalation.resource),
    escalation.reason,
    escalation.impact,
    JSON.stringify(escalation.options),
    escalation.recommendation,
    escalation.status,
    escalation.requiresSecond ? 1 : 0,
    escalation.createdAt,
    escalation.expiresAt,
    escalation.decidedAt ?? null,
    escalation.decidedBy ?? null,
    escalation.decisionReason ?? null,
  );
}

export function updateEscalation(db: DatabaseSync, escalation: Escalation): void {
  db.prepare(
    `UPDATE escalations SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?`,
  ).run(
    escalation.status,
    escalation.decidedAt ?? null,
    escalation.decidedBy ?? null,
    escalation.decisionReason ?? null,
    escalation.id,
  );
}

export function getEscalation(db: DatabaseSync, id: string): Escalation | undefined {
  const row = db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as Row | undefined;
  return row ? escalationFromRow(row) : undefined;
}

export function listEscalations(db: DatabaseSync, status?: EscalationStatus): Escalation[] {
  const rows = status
    ? (db.prepare('SELECT * FROM escalations WHERE status = ? ORDER BY created_at ASC').all(status) as Row[])
    : (db.prepare('SELECT * FROM escalations ORDER BY created_at ASC').all() as Row[]);
  return rows.map(escalationFromRow);
}

// ---------- Approval ----------

function approvalFromRow(row: Row): Approval {
  return {
    id: String(row.id),
    escalationId: String(row.escalation_id),
    goalId: String(row.goal_id),
    subject: String(row.subject),
    action: String(row.action) as Approval['action'],
    resourceKey: String(row.resource_key),
    createdAt: String(row.created_at),
    usedAt: optionalString(row.used_at),
  };
}

export function insertApproval(db: DatabaseSync, approval: Approval): void {
  db.prepare(
    `INSERT INTO approvals (id, escalation_id, goal_id, subject, action, resource_key, created_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approval.id,
    approval.escalationId,
    approval.goalId,
    approval.subject,
    approval.action,
    approval.resourceKey,
    approval.createdAt,
    approval.usedAt ?? null,
  );
}

export function findUsableApproval(
  db: DatabaseSync,
  goalId: string,
  subject: string,
  action: string,
  resourceKey: string,
): Approval | undefined {
  const row = db
    .prepare(
      `SELECT * FROM approvals
       WHERE goal_id = ? AND subject = ? AND action = ? AND resource_key = ? AND used_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(goalId, subject, action, resourceKey) as Row | undefined;
  return row ? approvalFromRow(row) : undefined;
}

export function markApprovalUsed(db: DatabaseSync, id: string, at: string): void {
  db.prepare('UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, id);
}