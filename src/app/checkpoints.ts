import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, Checkpoint, CheckpointKind } from '../domain/types.ts';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import {
  insertCheckpoint,
  listCheckpointsForGoal,
  listCheckpointsForItem,
} from '../infra/store.ts';

export interface RecordCheckpointInput {
  goalId: string;
  workItemId: string;
  kind: CheckpointKind;
  runId?: string;
  payload?: unknown;
}

/**
 * 记录一个已完成的写操作。
 *
 * 检查点与审计同时写入：审计用于时间线，检查点用于恢复时判断哪些写操作不必重放。
 * 只允许追加，不提供更新或删除入口，避免恢复时"优化"历史。
 */
export function recordCheckpoint(
  db: DatabaseSync,
  input: RecordCheckpointInput,
  now = new Date(),
): Checkpoint {
  const at = now.toISOString();
  const payload = input.payload ?? null;
  const event = appendAudit(
    db,
    {
      actor: 'system',
      type: 'checkpoint.recorded',
      goalId: input.goalId,
      payload: {
        workItemId: input.workItemId,
        kind: input.kind,
        runId: input.runId,
        detail: payload,
      },
    },
    at,
  );

  const checkpoint: Checkpoint = {
    id: randomUUID(),
    goalId: input.goalId,
    workItemId: input.workItemId,
    kind: input.kind,
    payload,
    createdAt: at,
    ...(input.runId ? { runId: input.runId } : {}),
    auditId: event.id,
  };
  insertCheckpoint(db, checkpoint);
  return checkpoint;
}

export interface CheckpointSummary {
  id: string;
  workItemId: string;
  kind: CheckpointKind;
  runId?: string;
  createdAt: string;
}

export function summarizeCheckpoints(checkpoints: Checkpoint[]): CheckpointSummary[] {
  return checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    workItemId: checkpoint.workItemId,
    kind: checkpoint.kind,
    ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
    createdAt: checkpoint.createdAt,
  }));
}

export function getGoalCheckpoints(db: DatabaseSync, goalId: string): Checkpoint[] {
  return listCheckpointsForGoal(db, goalId);
}

export interface RepeatWriteAssessment {
  skip: boolean;
  checkpoint?: Checkpoint;
  reason?: string;
}

/**
 * 判断某个工作项的写操作是否已经完成。
 *
 * 若存在检查点，且之后没有"判定不通过"或"验收返工"，则不应再执行一次实现；
 * 这样暂停恢复后不会重复写同一批文件，返工仍会正常产生新的 Run。
 */
export function assessRepeatWrite(
  db: DatabaseSync,
  goalId: string,
  workItemId: string,
): RepeatWriteAssessment {
  const checkpoints = listCheckpointsForItem(db, goalId, workItemId);
  const checkpoint = checkpoints[checkpoints.length - 1];
  if (!checkpoint) return { skip: false };

  const events = listAuditEvents(db, goalId);
  const index = checkpoint.auditId
    ? events.findIndex((event) => event.id === checkpoint.auditId)
    : -1;
  const after = index === -1 ? [] : events.slice(index + 1);
  if (after.some((event) => isReopenSignal(event, workItemId))) {
    return { skip: false };
  }

  return {
    skip: true,
    checkpoint,
    reason: `工作项已完成写操作（${checkpoint.kind}），不再重复执行`,
  };
}

function isReopenSignal(event: AuditEvent, workItemId: string): boolean {
  if (event.type === 'acceptance.decided') {
    return (event.payload as { decision?: string }).decision === 'rework';
  }
  if (event.type !== 'verifier.verdicts_recorded') return false;
  const record = event.payload as {
    workItemId?: string;
    verdicts?: { result?: string }[];
  };
  if (record.workItemId !== workItemId) return false;
  return (record.verdicts ?? []).some((verdict) => verdict.result !== 'passed');
}