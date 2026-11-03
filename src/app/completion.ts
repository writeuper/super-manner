import type { DatabaseSync } from 'node:sqlite';
import { appendAudit } from '../infra/audit.ts';
import { getLatestEvidence } from './evidence.ts';
import { getGoalOrThrow } from './goals.ts';
import { getApprovedPlan } from './plans.ts';
import { getLatestVerdicts } from './verdicts.ts';

export interface WorkItemCompletion {
  workItemId: string;
  title: string;
  criteria: number;
  passed: number;
  failed: number;
  undetermined: number;
  verdictsRecordedAt?: string;
  evidenceCollectedAt?: string;
  complete: boolean;
  reasons: string[];
}

export interface CompletionAssessment {
  goalId: string;
  assessedAt: string;
  workItems: WorkItemCompletion[];
  goal: {
    complete: boolean;
    reasons: string[];
  };
}

export interface AssessCompletionInput {
  goalId: string;
  actor?: string;
}

/**
 * 完成判定：工作项与目标两级 DoD。
 *
 * 工作项要同时具备证据与逐条判定，且没有"不通过 / 无法判定"；
 * 目标要求已批准计划里的全部工作项完成。判定结果写入审计，便于验收与追溯。
 */
export function assessCompletion(
  db: DatabaseSync,
  input: AssessCompletionInput,
  now = new Date(),
): CompletionAssessment {
  const goal = getGoalOrThrow(db, input.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能做完成判定');

  const workItems: WorkItemCompletion[] = plan.workItems.map((item) => {
    const verdicts = getLatestVerdicts(db, goal.id, item.id);
    const evidence = getLatestEvidence(db, goal.id, item.id);
    const reasons: string[] = [];

    if (!verdicts) {
      reasons.push('没有逐条判定');
    } else {
      if (verdicts.summary.failed > 0) reasons.push(`有 ${verdicts.summary.failed} 条标准未通过`);
      if (verdicts.summary.undetermined > 0) {
        reasons.push(`有 ${verdicts.summary.undetermined} 条标准无法判定`);
      }
    }
    if (!evidence) reasons.push('没有可复用的证据');

    const result: WorkItemCompletion = {
      workItemId: item.id,
      title: item.title,
      criteria: verdicts?.summary.total ?? new Set([...goal.acceptance, ...item.dod]).size,
      passed: verdicts?.summary.passed ?? 0,
      failed: verdicts?.summary.failed ?? 0,
      undetermined: verdicts?.summary.undetermined ?? 0,
      complete: reasons.length === 0,
      reasons,
    };
    if (verdicts) result.verdictsRecordedAt = verdicts.recordedAt;
    if (evidence) result.evidenceCollectedAt = evidence.collectedAt;
    return result;
  });

  const reasons = workItems
    .filter((item) => !item.complete)
    .map((item) => `工作项 ${item.workItemId} 未完成：${item.reasons.join('；')}`);

  const assessment: CompletionAssessment = {
    goalId: goal.id,
    assessedAt: now.toISOString(),
    workItems,
    goal: { complete: reasons.length === 0, reasons },
  };

  appendAudit(
    db,
    {
      actor: input.actor ?? 'verifier',
      type: 'verifier.completion_assessed',
      goalId: goal.id,
      payload: assessment,
    },
    assessment.assessedAt,
  );

  return assessment;
}