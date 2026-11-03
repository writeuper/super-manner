import type { DatabaseSync } from 'node:sqlite';
import { appendAudit } from '../infra/audit.ts';
import { listGrantsForGoal, revokeGrantsForGoal } from '../infra/store.ts';
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