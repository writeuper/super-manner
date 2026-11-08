import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { runGit } from '../infra/git.ts';
import { findActiveWorkspace } from '../infra/store.ts';
import { getLatestCheckpoint } from './checkpoints.ts';
import { getLatestEvidence } from './evidence.ts';
import { getGoalOrThrow } from './goals.ts';
import { getApprovedPlan } from './plans.ts';
import { reworkRound } from './rounds.ts';
import { getLatestVerdicts } from './verdicts.ts';
import { assertGoalVerifying } from './verification.ts';

export interface WorkItemCompletion {
  workItemId: string;
  title: string;
  criteria: number;
  passed: number;
  failed: number;
  undetermined: number;
  verdictsRecordedAt?: string;
  evidenceCollectedAt?: string;
  evidenceHead?: string;
  evaluatedHead?: string;
  evidenceCollectionId?: string;
  reworkRound?: number;
  deliveryHead?: string;
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

function checkpointSha(checkpoint: Checkpoint | undefined): string | undefined {
  const sha = (checkpoint?.payload as { sha?: unknown } | null)?.sha;
  return typeof sha === 'string' && sha.length > 0 ? sha : undefined;
}

/**
 * 完成判定：工作项与目标两级 DoD（只读，不写审计）。
 *
 * 工作项要同时具备证据与逐条判定，且没有"不通过 / 无法判定"；
 * 目标要求已批准计划里的全部工作项完成。
 */
export function computeCompletion(
  db: DatabaseSync,
  goalId: string,
  now = new Date(),
): CompletionAssessment {
  const goal = getGoalOrThrow(db, goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能做完成判定');
  const round = reworkRound(db, goal.id);

  const workItems: WorkItemCompletion[] = plan.workItems.map((item) => {
    const verdicts = getLatestVerdicts(db, goal.id, item.id);
    const evidence = getLatestEvidence(db, goal.id, item.id);
    const commit = getLatestCheckpoint(db, goal.id, item.id, 'commit');
    const push = getLatestCheckpoint(db, goal.id, item.id, 'push');
    const commitHead = checkpointSha(commit);
    const pushHead = checkpointSha(push);
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

    if (evidence && evidence.reworkRound !== round) {
      reasons.push(`证据属于第 ${evidence.reworkRound} 轮，当前为第 ${round} 轮`);
    }

    if (verdicts && evidence) {
      if (!verdicts.evaluatedHead) {
        reasons.push('逐条判定未绑定证据提交');
      } else if (verdicts.evaluatedHead !== evidence.head) {
        reasons.push('逐条判定对应的提交与最新证据不一致');
      }
      if (verdicts.evidenceCollectionId !== evidence.collectionId) {
        reasons.push('逐条判定未绑定最新证据采集');
      }
      if ((verdicts.reworkRound ?? 1) !== evidence.reworkRound) {
        reasons.push('逐条判定与证据不属于同一返工轮次');
      }
    }

    if (evidence && commitHead && evidence.head !== commitHead) {
      reasons.push(
        `证据对应提交与最新提交不一致（证据 ${evidence.head.slice(0, 8)}，提交 ${commitHead.slice(0, 8)}）`,
      );
    }

    if (item.role === 'builder') {
      if (!commitHead) {
        reasons.push('没有提交检查点');
      } else if (!push) {
        reasons.push('没有成功推送的交付提交');
      } else if (!pushHead) {
        reasons.push('推送检查点缺少提交 SHA');
      } else if (pushHead !== commitHead) {
        reasons.push(
          `最新提交尚未推送（提交 ${commitHead.slice(0, 8)}，已推送 ${pushHead.slice(0, 8)}）`,
        );
      }
    } else if (pushHead && commitHead && pushHead !== commitHead) {
      reasons.push(
        `最新提交尚未推送（提交 ${commitHead.slice(0, 8)}，已推送 ${pushHead.slice(0, 8)}）`,
      );
    }

    if (item.role === 'builder' && commitHead) {
      const workspace = findActiveWorkspace(db, goal.id, item.id);
      if (workspace) {
        const currentHead = runGit(['rev-parse', 'HEAD'], { cwd: workspace.path }).stdout.trim();
        if (currentHead && currentHead !== commitHead) {
          reasons.push('工作区当前提交与交付提交不一致');
        }
        if (runGit(['status', '--porcelain'], { cwd: workspace.path }).stdout.trim().length > 0) {
          reasons.push('工作区存在未提交改动');
        }
      }
    }

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
    if (evidence) result.evidenceHead = evidence.head;
    if (evidence) result.evidenceCollectionId = evidence.collectionId;
    if (evidence) result.reworkRound = evidence.reworkRound;
    if (verdicts?.evaluatedHead) result.evaluatedHead = verdicts.evaluatedHead;
    if (commitHead) result.deliveryHead = commitHead;
    else if (pushHead) result.deliveryHead = pushHead;
    return result;
  });

  const reasons = workItems
    .filter((item) => !item.complete)
    .map((item) => `工作项 ${item.workItemId} 未完成：${item.reasons.join('；')}`);

  return {
    goalId: goal.id,
    assessedAt: now.toISOString(),
    workItems,
    goal: { complete: reasons.length === 0, reasons },
  };
}

/** 完成判定并写入审计，便于验收与追溯。 */
export function assessCompletion(
  db: DatabaseSync,
  input: AssessCompletionInput,
  now = new Date(),
): CompletionAssessment {
  assertGoalVerifying(db, input.goalId, '做完成判定');
  const assessment = computeCompletion(db, input.goalId, now);
  appendAudit(
    db,
    {
      actor: input.actor ?? 'verifier',
      type: 'verifier.completion_assessed',
      goalId: assessment.goalId,
      payload: assessment,
    },
    assessment.assessedAt,
  );
  return assessment;
}