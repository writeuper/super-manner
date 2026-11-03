import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { requiresSecondPerson, resourceKey } from '../domain/actions.ts';
import { canTransitionGoal, isTerminalGoal } from '../domain/state.ts';
import type { Action, Escalation, ResourceRef } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import {
  getEscalation,
  getGoal,
  insertApproval,
  insertEscalation,
  listEscalations,
  updateEscalation,
  updateGoal,
} from '../infra/store.ts';

export const DEFAULT_ESCALATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateEscalationInput {
  goalId: string;
  subject: string;
  action: Action;
  resource: ResourceRef;
  reason: string;
  impact?: string;
  options?: string[];
  recommendation?: string;
}

export function createEscalation(
  db: DatabaseSync,
  input: CreateEscalationInput,
  now = new Date(),
  ttlMs = DEFAULT_ESCALATION_TTL_MS,
): Escalation {
  const goal = getGoal(db, input.goalId);
  if (!goal) throw new Error(`目标不存在：${input.goalId}`);
  if (isTerminalGoal(goal.status)) throw new Error(`目标已结束，不能创建升级：${goal.status}`);

  const key = resourceKey(input.resource);
  const existing = listEscalations(db, 'pending').find(
    (item) =>
      item.goalId === input.goalId &&
      item.subject === input.subject &&
      item.action === input.action &&
      resourceKey(item.resource) === key,
  );
  if (existing) return existing;

  const at = now.toISOString();
  const escalation: Escalation = {
    id: randomUUID(),
    goalId: input.goalId,
    subject: input.subject,
    action: input.action,
    resource: input.resource,
    reason: input.reason,
    impact: input.impact ?? '未说明',
    options: input.options ?? ['批准一次', '拒绝'],
    recommendation: input.recommendation ?? '请裁决',
    status: 'pending',
    requiresSecond: requiresSecondPerson(input.action, input.resource.repo !== goal.repo),
    createdAt: at,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  insertEscalation(db, escalation);
  appendAudit(
    db,
    {
      actor: input.subject,
      type: 'escalation.created',
      goalId: input.goalId,
      subject: input.subject,
      payload: {
        escalationId: escalation.id,
        action: escalation.action,
        resource: escalation.resource,
        requiresSecond: escalation.requiresSecond,
        expiresAt: escalation.expiresAt,
      },
    },
    at,
  );

  return escalation;
}

export interface EscalationDecision {
  approver: string;
  approve: boolean;
  reason?: string;
  secondApprover?: string;
}

/**
 * 裁决只能针对待处理且未超时的卡片。
 * 批准会产生一张一次性通行证，由网关消费；卡片本身不会长期放大权限。
 */
export function decideEscalation(
  db: DatabaseSync,
  escalationId: string,
  decision: EscalationDecision,
  now = new Date(),
): Escalation {
  const escalation = getEscalation(db, escalationId);
  if (!escalation) throw new Error(`升级不存在：${escalationId}`);
  if (escalation.status !== 'pending') throw new Error(`升级已处理，当前：${escalation.status}`);

  const at = now.toISOString();
  if (now.getTime() >= new Date(escalation.expiresAt).getTime()) {
    const expired: Escalation = { ...escalation, status: 'expired', decidedAt: at, decisionReason: '超时' };
    updateEscalation(db, expired);
    appendAudit(db, { actor: 'system', type: 'escalation.expired', goalId: escalation.goalId, payload: { escalationId } }, at);
    blockGoal(db, escalation.goalId, '升级超时', at);
    throw new Error('升级已超时，不能裁决');
  }

  if (escalation.requiresSecond) {
    if (!decision.secondApprover) throw new Error('该动作需要第二人确认');
    if (decision.secondApprover === decision.approver) throw new Error('第二人不能与第一人相同');
  }

  if (!decision.approve) {
    const denied: Escalation = {
      ...escalation,
      status: 'denied',
      decidedAt: at,
      decidedBy: decision.approver,
      decisionReason: decision.reason ?? '',
    };
    updateEscalation(db, denied);
    appendAudit(
      db,
      {
        actor: decision.approver,
        type: 'escalation.denied',
        goalId: escalation.goalId,
        payload: { escalationId, reason: denied.decisionReason, secondApprover: decision.secondApprover ?? null },
      },
      at,
    );
    return denied;
  }

  const approved: Escalation = {
    ...escalation,
    status: 'approved',
    decidedAt: at,
    decidedBy: decision.approver,
    decisionReason: decision.reason ?? '',
  };
  updateEscalation(db, approved);

  insertApproval(db, {
    id: randomUUID(),
    escalationId,
    goalId: escalation.goalId,
    subject: escalation.subject,
    action: escalation.action,
    resourceKey: resourceKey(escalation.resource),
    createdAt: at,
  });

  appendAudit(
    db,
    {
      actor: decision.approver,
      type: 'escalation.approved',
      goalId: escalation.goalId,
      subject: escalation.subject,
      payload: {
        escalationId,
        action: escalation.action,
        resource: escalation.resource,
        reason: approved.decisionReason,
        secondApprover: decision.secondApprover ?? null,
        oneTime: true,
      },
    },
    at,
  );

  return approved;
}

/** 超时扫描：只阻塞，不放行。 */
export function sweepExpiredEscalations(db: DatabaseSync, now = new Date()): number {
  const at = now.toISOString();
  let expired = 0;
  for (const escalation of listEscalations(db, 'pending')) {
    if (now.getTime() < new Date(escalation.expiresAt).getTime()) continue;
    updateEscalation(db, { ...escalation, status: 'expired', decidedAt: at, decisionReason: '超时' });
    appendAudit(
      db,
      { actor: 'system', type: 'escalation.expired', goalId: escalation.goalId, payload: { escalationId: escalation.id } },
      at,
    );
    blockGoal(db, escalation.goalId, '升级超时', at);
    expired += 1;
  }
  return expired;
}

function blockGoal(db: DatabaseSync, goalId: string, reason: string, at: string): void {
  const goal = getGoal(db, goalId);
  if (!goal || isTerminalGoal(goal.status)) return;
  if (!canTransitionGoal(goal.status, 'blocked')) return;
  updateGoal(db, { ...goal, status: 'blocked', updatedAt: at });
  appendAudit(db, { actor: 'system', type: 'goal.status_changed', goalId, payload: { from: goal.status, to: 'blocked', reason } }, at);
}