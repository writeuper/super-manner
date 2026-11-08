import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Executor, ExecutorStatus } from '../domain/executor.ts';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import { runGit } from '../infra/git.ts';
import { findActiveWorkspace } from '../infra/store.ts';
import { tailText } from '../infra/text.ts';
import { detectSelfChecks, DEFAULT_SELF_CHECK_TIMEOUT_MS, type SelfCheckSpec } from './builder.ts';
import { assertDependenciesComplete } from './dependencies.ts';
import { getApprovedPlan } from './plans.ts';
import { assertGoalVerifying } from './verification.ts';

export interface CollectEvidenceInput {
  goalId: string;
  workItemId: string;
  executor: Executor;
  /** 默认按工作区的 package.json 自动探测；传空数组表示不跑命令。 */
  checks?: SelfCheckSpec[];
  actor?: string;
}

export interface EvidenceEnv {
  node: string;
  platform: string;
  arch: string;
  cwd: string;
  branch: string;
  head: string;
}

export interface EvidenceRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  status: ExecutorStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** command + args + 记录中的输出摘要的 sha256，可离线重算核对。 */
  hash: string;
  env: EvidenceEnv;
}

export interface EvidenceCollection {
  goalId: string;
  workItemId: string;
  workspaceId: string;
  branch: string;
  head: string;
  collectedAt: string;
  evidence: EvidenceRecord[];
}

function evidenceHash(command: string, args: string[], stdout: string, stderr: string): string {
  return createHash('sha256')
    .update(`${command} ${args.join(' ')}\n${stdout}\n${stderr}`)
    .digest('hex');
}

/**
 * 采集验证证据。
 *
 * 每条证据都带命令、参数、工作目录、时间、退出码与环境快照，
 * 让另一个人可以照着重跑并核对同一份输出哈希。
 */
export async function collectEvidence(
  db: DatabaseSync,
  input: CollectEvidenceInput,
  now = new Date(),
): Promise<EvidenceCollection> {
  const goal = assertGoalVerifying(db, input.goalId, '采集证据');
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能采集证据');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  assertDependenciesComplete(db, goal.id, item, plan.workItems);

  const workspace = findActiveWorkspace(db, goal.id, item.id);
  if (!workspace) {
    throw new Error(`工作项 ${item.id} 没有活跃工作区，无法采集证据`);
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace.path }).stdout.trim();
  const head = runGit(['rev-parse', 'HEAD'], { cwd: workspace.path }).stdout.trim();
  const env: EvidenceEnv = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: workspace.path,
    branch,
    head,
  };

  const checks = input.checks ?? detectSelfChecks(workspace.path);
  const evidence: EvidenceRecord[] = [];
  for (const check of checks) {
    const result = await input.executor.run({
      command: check.command,
      args: check.args ?? [],
      cwd: workspace.path,
      timeoutMs: check.timeoutMs ?? DEFAULT_SELF_CHECK_TIMEOUT_MS,
    });
    const stdout = tailText(result.stdout, 4000);
    const stderr = tailText(result.stderr, 4000);
    evidence.push({
      id: randomUUID(),
      name: check.name,
      command: check.command,
      args: check.args ?? [],
      cwd: workspace.path,
      status: result.status,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      durationMs: result.durationMs,
      stdout,
      stderr,
      hash: evidenceHash(check.command, check.args ?? [], stdout, stderr),
      env,
    });
  }

  const collectedAt = now.toISOString();
  appendAudit(
    db,
    {
      actor: input.actor ?? 'verifier',
      type: 'verifier.evidence_collected',
      goalId: goal.id,
      subject: item.grant.subject,
      payload: { workItemId: item.id, workspaceId: workspace.id, branch, head, collectedAt, evidence },
    },
    collectedAt,
  );

  return {
    goalId: goal.id,
    workItemId: item.id,
    workspaceId: workspace.id,
    branch,
    head,
    collectedAt,
    evidence,
  };
}

/** 从审计链取该工作项最近一次证据采集。 */
export function getLatestEvidence(
  db: DatabaseSync,
  goalId: string,
  workItemId: string,
): EvidenceCollection | undefined {
  const events = listAuditEvents(db, goalId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'verifier.evidence_collected') continue;
    const payload = event.payload as EvidenceCollection;
    if (payload.workItemId === workItemId) return payload;
  }
  return undefined;
}