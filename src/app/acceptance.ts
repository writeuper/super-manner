import type { DatabaseSync } from 'node:sqlite';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import { listGrantsForGoal, revokeGrantsForGoal, transaction } from '../infra/store.ts';
import { computeCompletion } from './completion.ts';
import { cancelGoal, getGoalOrThrow, setGoalStatus } from './goals.ts';

export type AcceptanceDecision = 'accept' | 'rework' | 'close';

export interface DecideAcceptanceInput {
  goalId: string;
  decision: AcceptanceDecision;
  /** 返工与关闭必须写明原因；接受可省略。 */
  reason?: string;
  actor: string;
}

export interface AcceptanceDecisionRecord {
  goalId: string;
  decision: AcceptanceDecision;
  decidedAt: string;
  reason: string;
  goalStatus: string;
  complete: boolean;
  revokedGrants: number;
}

/** 验证完成后将目标交给人工验收。重复提交保留原来的入队时间。 */
export function submitForAcceptance(
  db: DatabaseSync,
  input: { goalId: string; actor?: string },
  now = new Date(),
): { goalId: string; status: 'awaiting_acceptance'; submittedAt: string } {
  return transaction(db, () => {
    const goal = getGoalOrThrow(db, input.goalId);
    if (goal.status !== 'verifying' && goal.status !== 'awaiting_acceptance') {
      throw new Error(`目标当前状态不能提交验收：${goal.status}`);
    }
    const assessment = computeCompletion(db, goal.id, now);
    if (!assessment.goal.complete) {
      throw new Error(`完成判定未通过，不能提交验收：${assessment.goal.reasons.join('；')}`);
    }
    if (goal.status === 'awaiting_acceptance') {
      return {
        goalId: goal.id,
        status: 'awaiting_acceptance',
        submittedAt: latestSubmissionAt(db, goal.id) ?? goal.updatedAt,
      };
    }

    const actor = input.actor ?? 'verifier';
    const submitted = setGoalStatus(db, goal, 'awaiting_acceptance', actor, now);
    appendAudit(
      db,
      {
        actor,
        type: 'acceptance.submitted',
        goalId: goal.id,
        payload: { submittedAt: submitted.updatedAt, complete: true },
      },
      submitted.updatedAt,
    );
    return { goalId: submitted.id, status: 'awaiting_acceptance', submittedAt: submitted.updatedAt };
  });
}

function latestSubmissionAt(db: DatabaseSync, goalId: string): string | undefined {
  const events = listAuditEvents(db, goalId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'acceptance.submitted') continue;
    const submittedAt = (event.payload as { submittedAt?: unknown }).submittedAt;
    if (typeof submittedAt === 'string') return submittedAt;
  }
  return undefined;
}

/**
 * 人工验收决定。
 *
 * - accept：完成判定通过后目标转 completed，并吊销全部授权；
 * - rework：目标回到 executing，历史证据与判定保留，Builder 产生新的 Run；
 * - close：目标取消，授权吊销，未决升级过期。
 */
export function decideAcceptance(
  db: DatabaseSync,
  input: DecideAcceptanceInput,
  now = new Date(),
): AcceptanceDecisionRecord {
  const goal = getGoalOrThrow(db, input.goalId);
  const at = now.toISOString();
  const reason = input.reason?.trim() ?? '';

  if (input.decision !== 'accept' && reason.length === 0) {
    throw new Error('返工或关闭必须说明原因');
  }
  if (input.decision === 'close') {
    const active = listGrantsForGoal(db, goal.id).filter((grant) => grant.status === 'active').length;
    const cancelled = cancelGoal(db, goal.id, input.actor, now);
    return finish(db, input, at, reason, cancelled.status, false, active);
  }

  if (goal.status !== 'verifying' && goal.status !== 'awaiting_acceptance') {
    throw new Error(`目标当前状态不能做验收决定：${goal.status}`);
  }

  if (input.decision === 'rework') {
    const executing = setGoalStatus(db, goal, 'executing', input.actor, now);
    return finish(db, input, at, reason, executing.status, false, 0);
  }

  const assessment = computeCompletion(db, goal.id, now);
  if (!assessment.goal.complete) {
    throw new Error(`完成判定未通过，不能接受：${assessment.goal.reasons.join('；')}`);
  }

  let updated = goal;
  if (updated.status === 'verifying') {
    updated = setGoalStatus(db, updated, 'awaiting_acceptance', input.actor, now);
  }
  updated = setGoalStatus(db, updated, 'completed', input.actor, now);

  const revoked = revokeGrantsForGoal(db, goal.id, at, '目标完成');
  if (revoked > 0) {
    appendAudit(db, { actor: input.actor, type: 'grants.revoked', goalId: goal.id, payload: { count: revoked, reason: '目标完成' } }, at);
  }

  return finish(db, input, at, reason, updated.status, true, revoked);
}

function finish(
  db: DatabaseSync,
  input: DecideAcceptanceInput,
  at: string,
  reason: string,
  goalStatus: string,
  complete: boolean,
  revokedGrants: number,
): AcceptanceDecisionRecord {
  const record: AcceptanceDecisionRecord = {
    goalId: input.goalId,
    decision: input.decision,
    decidedAt: at,
    reason,
    goalStatus,
    complete,
    revokedGrants,
  };
  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'acceptance.decided',
      goalId: input.goalId,
      payload: record,
    },
    at,
  );
  return record;
}
