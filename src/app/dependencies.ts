import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint, WorkItem } from '../domain/types.ts';
import { listAuditEvents } from '../infra/audit.ts';
import { listCheckpointsForItem } from '../infra/store.ts';
import { reworkRound } from './rounds.ts';

interface CollectedEvidence {
  workItemId?: string;
  head?: string;
  collectionId?: string;
  reworkRound?: number;
}

interface RecordedVerdicts {
  workItemId?: string;
  evaluatedHead?: string;
  evidenceCollectionId?: string;
  reworkRound?: number;
  summary?: { complete?: boolean };
}

function latestPayload<T>(db: DatabaseSync, goalId: string, type: string, workItemId: string): T | undefined {
  const events = listAuditEvents(db, goalId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== type) continue;
    const payload = event.payload as { workItemId?: unknown };
    if (payload.workItemId === workItemId) return event.payload as T;
  }
  return undefined;
}

function checkpointSha(checkpoint: Checkpoint | undefined): string | undefined {
  const sha = (checkpoint?.payload as { sha?: unknown } | null)?.sha;
  return typeof sha === 'string' && sha.length > 0 ? sha : undefined;
}

/** 依赖工作项未完成的原因；空数组表示可以继续。 */
export function dependencyReasons(db: DatabaseSync, goalId: string, dependency: WorkItem): string[] {
  const evidence = latestPayload<CollectedEvidence>(db, goalId, 'verifier.evidence_collected', dependency.id);
  const verdicts = latestPayload<RecordedVerdicts>(db, goalId, 'verifier.verdicts_recorded', dependency.id);
  const checkpoints = listCheckpointsForItem(db, goalId, dependency.id);
  const commitSha = checkpointSha(checkpoints.filter((checkpoint) => checkpoint.kind === 'commit').at(-1));
  const pushSha = checkpointSha(checkpoints.filter((checkpoint) => checkpoint.kind === 'push').at(-1));
  const round = reworkRound(db, goalId);

  const reasons: string[] = [];
  if (!evidence?.head) reasons.push('没有证据');
  if (!verdicts) reasons.push('没有逐条判定');
  else if (!verdicts.summary?.complete) reasons.push('判定未全部通过');

  if (evidence && evidence.reworkRound !== round) {
    reasons.push('证据属于上一轮返工');
  }
  if (verdicts && (verdicts.reworkRound ?? 1) !== round) {
    reasons.push('判定属于上一轮返工');
  }

  if (evidence?.head && verdicts) {
    if (!verdicts.evaluatedHead) reasons.push('判定未绑定证据提交');
    else if (verdicts.evaluatedHead !== evidence.head) reasons.push('判定与证据提交不一致');
    if (verdicts.evidenceCollectionId !== evidence.collectionId) {
      reasons.push('判定未绑定最新证据采集');
    }
  }
  if (evidence?.head && commitSha && evidence.head !== commitSha) {
    reasons.push('证据与最新提交不一致');
  }

  if (dependency.role === 'builder') {
    if (!commitSha) reasons.push('没有提交');
    if (!pushSha) reasons.push('没有推送');
    else if (commitSha && pushSha !== commitSha) reasons.push('最新提交尚未推送');
  }

  return reasons;
}

/** 执行或验证一个工作项前，要求它的全部前置工作项都已完成。 */
export function assertDependenciesComplete(
  db: DatabaseSync,
  goalId: string,
  item: WorkItem,
  items: WorkItem[],
): void {
  if (item.dependsOn.length === 0) return;
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  for (const dependencyId of item.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (!dependency) {
      throw new Error(`工作项 ${item.id} 依赖不存在的工作项：${dependencyId}`);
    }
    const reasons = dependencyReasons(db, goalId, dependency);
    if (reasons.length > 0) {
      throw new Error(`工作项 ${item.id} 依赖 ${dependency.id} 尚未完成：${reasons.join('；')}`);
    }
  }
}