import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import { assertDependenciesComplete } from './dependencies.ts';
import { getLatestEvidence } from './evidence.ts';
import { getApprovedPlan } from './plans.ts';
import { classifyVerdicts, type FailureKind } from './retries.ts';
import { reworkRound } from './rounds.ts';
import { assertGoalVerifying } from './verification.ts';

export type VerdictResult = 'passed' | 'failed' | 'undetermined';

export interface VerdictInput {
  criterion: string;
  result: VerdictResult;
  /** 结论依据，必须写明；不接受空说明。 */
  note: string;
  /** 引用的证据 id 或哈希，需能在最近一次证据采集里找到。 */
  evidence?: string[];
}

export interface Verdict {
  criterion: string;
  result: VerdictResult;
  note: string;
  evidence: string[];
}

export interface RecordVerdictsInput {
  goalId: string;
  workItemId: string;
  verdicts: VerdictInput[];
  actor?: string;
}

export interface VerdictRecord {
  id: string;
  goalId: string;
  workItemId: string;
  recordedAt: string;
  /** 判定所依据的证据对应的提交。 */
  evaluatedHead?: string;
  /** 判定绑定的证据采集批次；换一批采集后旧判定自动失效。 */
  evidenceCollectionId?: string;
  /** 判定所属的返工轮次。 */
  reworkRound?: number;
  verdicts: Verdict[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    undetermined: number;
    /** 全部标准都有结论且没有"不通过 / 无法判定"时才为 true。 */
    complete: boolean;
  };
  /** 判定失败归类：不通过为实现问题，只有无法判定为验证问题。 */
  failureKind?: FailureKind;
}

const RESULTS: VerdictResult[] = ['passed', 'failed', 'undetermined'];

function summarize(verdicts: Verdict[]): VerdictRecord['summary'] {
  const passed = verdicts.filter((verdict) => verdict.result === 'passed').length;
  const failed = verdicts.filter((verdict) => verdict.result === 'failed').length;
  const undetermined = verdicts.filter((verdict) => verdict.result === 'undetermined').length;
  return {
    total: verdicts.length,
    passed,
    failed,
    undetermined,
    complete: failed === 0 && undetermined === 0,
  };
}

/**
 * 记录逐条判定。
 *
 * 判定覆盖目标的验收标准与工作项的完成标准，每条必须有结论与说明；
 * 只有全部通过才算完成，有"不通过"或"无法判定"时必须保持未完成。
 */
export function recordVerdicts(
  db: DatabaseSync,
  input: RecordVerdictsInput,
  now = new Date(),
): VerdictRecord {
  const goal = assertGoalVerifying(db, input.goalId, '记录判定');
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能记录判定');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  assertDependenciesComplete(db, goal.id, item, plan.workItems);

  const criteria = [...new Set([...goal.acceptance, ...item.dod])];
  const known = new Set(criteria);
  const seen = new Set<string>();
  const latestEvidence = getLatestEvidence(db, goal.id, item.id);
  if (!latestEvidence) {
    throw new Error(`工作项 ${item.id} 没有可绑定的证据采集，不能记录判定`);
  }
  const round = reworkRound(db, goal.id);
  if (latestEvidence.reworkRound !== round) {
    throw new Error(
      `最新证据属于第 ${latestEvidence.reworkRound} 轮，当前为第 ${round} 轮，请重新采集证据`,
    );
  }
  const evidence = latestEvidence.evidence;
  const evidenceKeys = new Set(evidence.flatMap((record) => [record.id, record.hash]));

  for (const verdict of input.verdicts) {
    if (!known.has(verdict.criterion)) {
      throw new Error(`判定标准不在目标验收或工作项完成标准内：${verdict.criterion}`);
    }
    if (seen.has(verdict.criterion)) {
      throw new Error(`同一条标准不能重复判定：${verdict.criterion}`);
    }
    seen.add(verdict.criterion);
    if (!RESULTS.includes(verdict.result)) {
      throw new Error(`未知判定结果：${verdict.result}`);
    }
    if (verdict.note.trim().length === 0) {
      throw new Error(`判定缺少说明：${verdict.criterion}`);
    }
    for (const reference of verdict.evidence ?? []) {
      if (!evidenceKeys.has(reference)) {
        throw new Error(`引用的证据不存在于最近一次采集：${reference}`);
      }
    }
  }

  const missing = criteria.filter((criterion) => !seen.has(criterion));
  if (missing.length > 0) {
    throw new Error(`以下标准尚未给出结论：${missing.join('、')}`);
  }

  const verdicts: Verdict[] = input.verdicts.map((verdict) => ({
    criterion: verdict.criterion,
    result: verdict.result,
    note: verdict.note.trim(),
    evidence: verdict.evidence ?? [],
  }));
  const recordedAt = now.toISOString();
  const failureKind = classifyVerdicts(verdicts);
  const record: VerdictRecord = {
    id: randomUUID(),
    goalId: goal.id,
    workItemId: item.id,
    recordedAt,
    evaluatedHead: latestEvidence.head,
    evidenceCollectionId: latestEvidence.collectionId,
    reworkRound: round,
    verdicts,
    summary: summarize(verdicts),
    ...(failureKind ? { failureKind } : {}),
  };

  appendAudit(
    db,
    {
      actor: input.actor ?? 'verifier',
      type: 'verifier.verdicts_recorded',
      goalId: goal.id,
      subject: item.grant.subject,
      payload: record,
    },
    recordedAt,
  );

  return record;
}

/** 从审计链取该工作项最近一次判定，供 S3-04 完成判定使用。 */
export function getLatestVerdicts(
  db: DatabaseSync,
  goalId: string,
  workItemId: string,
): VerdictRecord | undefined {
  const events = listAuditEvents(db, goalId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'verifier.verdicts_recorded') continue;
    const payload = event.payload as VerdictRecord;
    if (payload.workItemId === workItemId) return payload;
  }
  return undefined;
}