import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentRole,
  EvaluationResult,
  GoldenTask,
  PlaybookContent,
  PlaybookEvaluation,
  PlaybookMetrics,
  PlaybookProposal,
  PlaybookVersion,
} from '../domain/playbook.ts';
import { appendAudit } from '../infra/audit.ts';
import {
  decideProposal,
  findActiveVersion,
  findCanaryVersion,
  getGoldenTask,
  getProposal,
  getVersion,
  insertGoldenTask,
  insertProposal,
  insertVersion,
  listGoldenTasks,
  listVersions,
  markVersionActive,
  nextVersionNumber,
  retireVersion,
  updateProposalEvaluation,
} from '../infra/playbook-store.ts';
import { transaction } from '../infra/store.ts';
import { ROLE_PLAYBOOKS } from './playbook-defaults.ts';

const ROLES: AgentRole[] = ['planner', 'builder', 'verifier'];
const DEFAULT_MIN_PASS_RATE = 0.8;
const DEFAULT_MIN_TASKS = 3;

export type PlaybookChannel = 'builtin' | 'stable' | 'canary';

export interface ResolvedPlaybook {
  content: PlaybookContent;
  version?: PlaybookVersion;
  channel: PlaybookChannel;
}

export interface ProposePlaybookInput {
  role: AgentRole;
  content: PlaybookContent;
  rationale: string;
  actor: string;
  sourceGoalId?: string;
}

export interface ImportGoldenTasksInput {
  tasks: GoldenTask[];
  actor: string;
}

export interface RecordEvaluationInput {
  proposalId: string;
  results: EvaluationResult[];
  actor: string;
  minPassRate?: number;
  minTasks?: number;
}

export interface PromoteProposalInput {
  proposalId: string;
  actor: string;
  /** 1-99 进入灰度，0 或 100 直接全量。 */
  canaryPercent?: number;
}

function assertRole(role: string): asserts role is AgentRole {
  if (!ROLES.includes(role as AgentRole)) {
    throw new Error(`未知角色：${role}（可选：${ROLES.join(', ')}）`);
  }
}

function assertContent(role: AgentRole, content: PlaybookContent): void {
  if (content.role !== role) {
    throw new Error(`playbook 角色 ${content.role} 与提案角色 ${role} 不一致`);
  }
  if (content.name.trim().length === 0) throw new Error('playbook 缺少 name');
  if (content.objective.trim().length === 0) throw new Error('playbook 缺少 objective');
  if (!Array.isArray(content.steps) || content.steps.length === 0) {
    throw new Error('playbook 至少需要一条 steps');
  }
  if (!Array.isArray(content.boundaries) || content.boundaries.length === 0) {
    throw new Error('playbook 至少需要一条 boundaries');
  }
  for (const [field, values] of [
    ['steps', content.steps],
    ['boundaries', content.boundaries],
  ] as const) {
    if (values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error(`playbook 的 ${field} 不能包含空白条目`);
    }
  }
}

function assertActor(actor: string): void {
  if (actor.trim().length === 0) throw new Error('必须提供操作人');
}

function assertThreshold(minPassRate: number, minTasks: number): void {
  if (!(minPassRate >= 0 && minPassRate <= 1)) {
    throw new Error(`minPassRate 必须在 0-1 之间：${minPassRate}`);
  }
  if (!Number.isInteger(minTasks) || minTasks < 1) {
    throw new Error(`minTasks 必须是正整数：${minTasks}`);
  }
}

function toMetrics(evaluation: PlaybookEvaluation): PlaybookMetrics {
  const tasks: Record<string, boolean> = {};
  for (const result of evaluation.results) tasks[result.taskId] = result.passed;
  const tokens = evaluation.results.reduce<number | undefined>((sum, result) => {
    if (result.tokens === undefined) return sum;
    return (sum ?? 0) + result.tokens;
  }, undefined);
  return {
    passRate: evaluation.passRate,
    passed: evaluation.passed,
    total: evaluation.total,
    tasks,
    ...(tokens === undefined ? {} : { tokens }),
    evaluatedAt: evaluation.evaluatedAt,
  };
}

/** 同一 workItemId 在灰度期间稳定落在同一个桶里，保证会话可复现。 */
export function canaryBucket(role: AgentRole, workItemId: string): number {
  const digest = createHash('sha256').update(`${role}:${workItemId}`).digest();
  return digest.readUInt8(0) % 100;
}

/** 解析角色当前应使用的 playbook：灰度优先，其次稳定版，最后内置默认。 */
export function resolvePlaybook(
  db: DatabaseSync,
  role: AgentRole,
  workItemId: string,
): ResolvedPlaybook {
  const canary = findCanaryVersion(db, role);
  if (canary && canaryBucket(role, workItemId) < canary.canaryPercent) {
    return { content: canary.content, version: canary, channel: 'canary' };
  }
  const active = findActiveVersion(db, role);
  if (active) return { content: active.content, version: active, channel: 'stable' };
  return { content: ROLE_PLAYBOOKS[role], channel: 'builtin' };
}

export function proposePlaybook(
  db: DatabaseSync,
  input: ProposePlaybookInput,
  now = new Date(),
): PlaybookProposal {
  assertActor(input.actor);
  assertRole(input.role);
  assertContent(input.role, input.content);
  if (input.rationale.trim().length === 0) throw new Error('提案必须说明 rationale');

  const active = findActiveVersion(db, input.role);
  const current = active?.content ?? ROLE_PLAYBOOKS[input.role];
  if (JSON.stringify(current) === JSON.stringify(input.content)) {
    throw new Error('提案内容与当前生效版本一致');
  }

  const proposal: PlaybookProposal = {
    id: `pbp-${randomUUID().slice(0, 8)}`,
    role: input.role,
    ...(active ? { baseVersionId: active.id, baseVersion: active.version } : {}),
    content: input.content,
    rationale: input.rationale,
    ...(input.sourceGoalId === undefined ? {} : { sourceGoalId: input.sourceGoalId }),
    createdBy: input.actor,
    status: 'proposed',
    createdAt: now.toISOString(),
  };
  insertProposal(db, proposal);
  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.proposed',
      payload: {
        proposalId: proposal.id,
        role: proposal.role,
        baseVersion: proposal.baseVersion ?? null,
        rationale: proposal.rationale,
        ...(proposal.sourceGoalId ? { sourceGoalId: proposal.sourceGoalId } : {}),
      },
    },
    now.toISOString(),
  );
  return proposal;
}

export function importGoldenTasks(
  db: DatabaseSync,
  input: ImportGoldenTasksInput,
  now = new Date(),
): GoldenTask[] {
  assertActor(input.actor);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('黄金任务列表不能为空');
  }
  const seen = new Set<string>();
  for (const task of input.tasks) {
    assertRole(task.role);
    if (seen.has(task.id)) throw new Error(`黄金任务 id 重复：${task.id}`);
    seen.add(task.id);
    if (task.id.trim().length === 0) throw new Error('黄金任务缺少 id');
    if (task.title.trim().length === 0) throw new Error(`黄金任务 ${task.id} 缺少 title`);
    if (task.prompt.trim().length === 0) throw new Error(`黄金任务 ${task.id} 缺少 prompt`);
    if (!Array.isArray(task.criteria) || task.criteria.length === 0) {
      throw new Error(`黄金任务 ${task.id} 至少需要一条 criteria`);
    }
    if (getGoldenTask(db, task.id)) throw new Error(`黄金任务已存在：${task.id}`);
  }

  const createdAt = now.toISOString();
  transaction(db, () => {
    for (const task of input.tasks) insertGoldenTask(db, { ...task, createdAt });
  });

  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.golden_tasks_imported',
      payload: { count: input.tasks.length, ids: input.tasks.map((task) => task.id) },
    },
    createdAt,
  );
  return input.tasks.map((task) => ({ ...task, createdAt }));
}

export function recordEvaluation(
  db: DatabaseSync,
  input: RecordEvaluationInput,
  now = new Date(),
): PlaybookEvaluation {
  assertActor(input.actor);
  const proposal = getProposal(db, input.proposalId);
  if (!proposal) throw new Error(`提案不存在：${input.proposalId}`);
  if (proposal.status === 'promoted' || proposal.status === 'rejected') {
    throw new Error(`提案状态 ${proposal.status} 不能再次评测`);
  }

  const minPassRate = input.minPassRate ?? DEFAULT_MIN_PASS_RATE;
  const minTasks = input.minTasks ?? DEFAULT_MIN_TASKS;
  assertThreshold(minPassRate, minTasks);

  const golden = listGoldenTasks(db, proposal.role);
  if (golden.length < minTasks) {
    throw new Error(`黄金任务不足：${golden.length}/${minTasks}`);
  }

  const known = new Set(golden.map((task) => task.id));
  const seen = new Set<string>();
  for (const result of input.results) {
    if (!known.has(result.taskId)) throw new Error(`评测结果包含未知任务：${result.taskId}`);
    if (seen.has(result.taskId)) throw new Error(`评测结果任务重复：${result.taskId}`);
    if (typeof result.passed !== 'boolean') {
      throw new Error(`任务 ${result.taskId} 的 passed 必须是布尔值`);
    }
    seen.add(result.taskId);
  }
  const missing = [...known].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`评测结果缺少任务：${missing.join(', ')}`);

  const passed = input.results.filter((result) => result.passed).length;
  const total = golden.length;
  const passRate = total === 0 ? 0 : passed / total;
  const active = findActiveVersion(db, proposal.role);
  const regressions =
    active?.metrics === undefined
      ? []
      : golden
          .filter(
            (task) =>
              active.metrics?.tasks[task.id] === true &&
              input.results.find((result) => result.taskId === task.id)?.passed === false,
          )
          .map((task) => task.id);

  const evaluation: PlaybookEvaluation = {
    proposalId: proposal.id,
    results: input.results,
    passed,
    total,
    passRate,
    minPassRate,
    minTasks,
    regressions: [...new Set(regressions)],
    evaluatedAt: now.toISOString(),
  };

  updateProposalEvaluation(db, proposal.id, evaluation);
  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.evaluated',
      payload: {
        proposalId: proposal.id,
        role: proposal.role,
        passed,
        total,
        passRate,
        regressions: evaluation.regressions,
        minPassRate,
        minTasks,
      },
    },
    now.toISOString(),
  );
  return evaluation;
}

export function promoteProposal(
  db: DatabaseSync,
  input: PromoteProposalInput,
  now = new Date(),
): PlaybookVersion {
  assertActor(input.actor);
  const proposal = getProposal(db, input.proposalId);
  if (!proposal) throw new Error(`提案不存在：${input.proposalId}`);
  if (proposal.status !== 'evaluated' || proposal.evaluation === undefined) {
    throw new Error('提案尚未完成评测，不能晋级');
  }
  if (input.actor === proposal.createdBy) {
    throw new Error('提案人不能自行晋级，需要他人复核');
  }

  const evaluation = proposal.evaluation;
  if (evaluation.passRate < evaluation.minPassRate) {
    throw new Error(`通过率 ${evaluation.passRate.toFixed(2)} 低于门槛 ${evaluation.minPassRate}`);
  }
  if (evaluation.regressions.length > 0) {
    throw new Error(`存在相对基线的回归：${evaluation.regressions.join(', ')}`);
  }

  const canaryPercent = input.canaryPercent ?? 100;
  if (!Number.isInteger(canaryPercent) || canaryPercent < 0 || canaryPercent > 100) {
    throw new Error(`canaryPercent 必须是 0-100 的整数：${canaryPercent}`);
  }
  const percent = canaryPercent === 0 ? 100 : canaryPercent;
  const isCanary = percent < 100;
  if (isCanary && findCanaryVersion(db, proposal.role)) {
    throw new Error(`角色 ${proposal.role} 已有灰度版本，先处理或回滚`);
  }

  const active = findActiveVersion(db, proposal.role);
  if (active && JSON.stringify(active.content) === JSON.stringify(proposal.content)) {
    throw new Error('提案内容与当前生效版本一致');
  }

  const createdAt = now.toISOString();
  const version: PlaybookVersion = {
    id: `pbv-${randomUUID().slice(0, 8)}`,
    role: proposal.role,
    version: nextVersionNumber(db, proposal.role),
    content: proposal.content,
    status: isCanary ? 'canary' : 'active',
    canaryPercent: percent,
    sourceProposalId: proposal.id,
    metrics: toMetrics(evaluation),
    createdAt,
    ...(isCanary ? {} : { activatedAt: createdAt }),
  };

  transaction(db, () => {
    if (isCanary) {
      insertVersion(db, version);
    } else {
      for (const current of listVersions(db, proposal.role)) {
        if (current.status === 'active' || current.status === 'canary') {
          retireVersion(db, current.id, createdAt);
        }
      }
      insertVersion(db, version);
    }
    decideProposal(db, proposal.id, {
      status: 'promoted',
      actor: input.actor,
      reason: `通过率 ${evaluation.passRate.toFixed(2)}，灰度 ${percent}%`,
      at: createdAt,
    });
  });

  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.promoted',
      payload: {
        proposalId: proposal.id,
        role: proposal.role,
        versionId: version.id,
        version: version.version,
        canaryPercent: percent,
        passRate: evaluation.passRate,
      },
    },
    createdAt,
  );
  return version;
}

export function activateVersion(
  db: DatabaseSync,
  input: { versionId: string; actor: string },
  now = new Date(),
): PlaybookVersion {
  assertActor(input.actor);
  const version = getVersion(db, input.versionId);
  if (!version) throw new Error(`版本不存在：${input.versionId}`);
  if (version.status === 'active') return version;

  const at = now.toISOString();
  transaction(db, () => {
    for (const current of listVersions(db, version.role)) {
      if (current.id === version.id) continue;
      if (current.status === 'active' || current.status === 'canary') {
        retireVersion(db, current.id, at);
      }
    }
    markVersionActive(db, version.id, at);
  });

  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.activated',
      payload: {
        role: version.role,
        versionId: version.id,
        version: version.version,
        passRate: version.metrics?.passRate ?? null,
      },
    },
    at,
  );
  return { ...version, status: 'active', canaryPercent: 100, activatedAt: at };
}

export function rollbackPlaybook(
  db: DatabaseSync,
  input: { role: AgentRole; actor: string; reason?: string },
  now = new Date(),
): { role: AgentRole; fromVersion?: number; toVersion?: number; channel: PlaybookChannel } {
  assertActor(input.actor);
  assertRole(input.role);
  const at = now.toISOString();
  const active = findActiveVersion(db, input.role);
  // 回滚目标是当前版本之前最近一个退役版本；灰度版本不算回滚目标。
  const previous = listVersions(db, input.role)
    .filter(
      (version) =>
        version.status === 'retired' &&
        (active === undefined || version.version < active.version),
    )
    .sort((left, right) => right.version - left.version)[0];

  transaction(db, () => {
    for (const version of listVersions(db, input.role)) {
      if (version.status === 'canary') retireVersion(db, version.id, at);
    }
    if (active) retireVersion(db, active.id, at);
    if (previous) markVersionActive(db, previous.id, at);
  });

  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.rolled_back',
      payload: {
        role: input.role,
        fromVersion: active?.version ?? null,
        toVersion: previous?.version ?? null,
        reason: input.reason ?? null,
      },
    },
    at,
  );

  return {
    role: input.role,
    ...(active ? { fromVersion: active.version } : {}),
    ...(previous ? { toVersion: previous.version } : {}),
    channel: previous ? 'stable' : 'builtin',
  };
}

export function rejectProposal(
  db: DatabaseSync,
  input: { proposalId: string; actor: string; reason: string },
  now = new Date(),
): PlaybookProposal {
  assertActor(input.actor);
  if (input.reason.trim().length === 0) throw new Error('驳回必须说明理由');
  const proposal = getProposal(db, input.proposalId);
  if (!proposal) throw new Error(`提案不存在：${input.proposalId}`);
  if (proposal.status === 'promoted') throw new Error('已晋级的提案不能驳回');
  if (proposal.status === 'rejected') throw new Error('提案已驳回');

  const at = now.toISOString();
  decideProposal(db, proposal.id, {
    status: 'rejected',
    actor: input.actor,
    reason: input.reason,
    at,
  });
  appendAudit(
    db,
    {
      actor: input.actor,
      type: 'playbook.rejected',
      payload: { proposalId: proposal.id, role: proposal.role, reason: input.reason },
    },
    at,
  );
  return { ...proposal, status: 'rejected', decidedAt: at, decidedBy: input.actor, decisionReason: input.reason };
}