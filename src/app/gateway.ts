import type { DatabaseSync } from 'node:sqlite';
import { resourceKey } from '../domain/actions.ts';
import { authorize } from '../domain/policy.ts';
import type { AuthorizationRequest } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { findUsableApproval, getGoal, listActiveGrantsForSubject, markApprovalUsed } from '../infra/store.ts';
import { createEscalation, DEFAULT_ESCALATION_TTL_MS } from './escalations.ts';

export type GatewayOutcome = 'allowed' | 'denied' | 'escalated';

export interface GatewayResult {
  outcome: GatewayOutcome;
  reason: string;
  grantId?: string;
  escalationId?: string;
  approvalId?: string;
  oneTime?: boolean;
}

export interface GatewayOptions {
  now?: Date;
  escalationTtlMs?: number;
}

const BLOCKED_STATUSES = new Set([
  'draft',
  'pending_confirmation',
  'blocked',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);

/**
 * 所有动作请求的唯一入口。
 *
 * 执行器在真正产生副作用之前必须先调用这里；denied/escalated 时不执行动作。
 * 一次性通行证也只在这里消费，保证"批准一次只用一次"。
 */
export function requestAction(
  db: DatabaseSync,
  request: AuthorizationRequest,
  options: GatewayOptions = {},
): GatewayResult {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const goal = getGoal(db, request.goalId);

  if (!goal) {
    return { outcome: 'denied', reason: '目标不存在' };
  }

  if (BLOCKED_STATUSES.has(goal.status)) {
    const reason = `目标当前状态不允许执行动作：${goal.status}`;
    appendAudit(
      db,
      { actor: request.subject, type: 'auth.denied', goalId: request.goalId, subject: request.subject, payload: { request, reason } },
      at,
    );
    return { outcome: 'denied', reason };
  }

  const grants = listActiveGrantsForSubject(db, request.goalId, request.subject);
  const result = authorize(request, grants, now);

  if (result.decision === 'allow') {
    appendAudit(
      db,
      {
        actor: request.subject,
        type: 'auth.allowed',
        goalId: request.goalId,
        subject: request.subject,
        payload: { request, grantId: result.grantId },
      },
      at,
    );
    return { outcome: 'allowed', reason: result.reason, grantId: result.grantId };
  }

  if (result.decision === 'deny') {
    appendAudit(
      db,
      { actor: request.subject, type: 'auth.denied', goalId: request.goalId, subject: request.subject, payload: { request, reason: result.reason } },
      at,
    );
    return { outcome: 'denied', reason: result.reason };
  }

  const key = resourceKey(request.resource);
  const approval = findUsableApproval(db, request.goalId, request.subject, request.action, key);
  if (approval) {
    markApprovalUsed(db, approval.id, at);
    appendAudit(
      db,
      {
        actor: request.subject,
        type: 'auth.allowed',
        goalId: request.goalId,
        subject: request.subject,
        payload: { request, approvalId: approval.id, oneTime: true },
      },
      at,
    );
    return { outcome: 'allowed', reason: '使用一次性批准', approvalId: approval.id, oneTime: true };
  }

  const escalation = createEscalation(
    db,
    {
      goalId: request.goalId,
      subject: request.subject,
      action: request.action,
      resource: request.resource,
      reason: result.reason,
      impact: '动作不会执行，目标等待人工裁决',
      options: ['批准一次', '拒绝'],
      recommendation: '确认资源范围后再批准',
    },
    now,
    options.escalationTtlMs ?? DEFAULT_ESCALATION_TTL_MS,
  );

  appendAudit(
    db,
    {
      actor: request.subject,
      type: 'auth.escalated',
      goalId: request.goalId,
      subject: request.subject,
      payload: { request, escalationId: escalation.id },
    },
    at,
  );

  return { outcome: 'escalated', reason: result.reason, escalationId: escalation.id };
}