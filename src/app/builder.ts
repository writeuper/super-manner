import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Executor, ExecutorResult, ExecutorStatus } from '../domain/executor.ts';
import type { Goal, Plan, ResourceRef, WorkItem } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { listChangedFiles, runGit } from '../infra/git.ts';
import { findActiveWorkspace } from '../infra/store.ts';
import { tailText } from '../infra/text.ts';
import { getGoalOrThrow } from './goals.ts';
import { assessRepeatWrite, recordCheckpoint } from './checkpoints.ts';
import { requestAction } from './gateway.ts';
import { getApprovedPlan } from './plans.ts';
import { instantiateRole, type RoleInstance } from './roles.ts';
import {
  assessBuilderRetry,
  classifyRunFailure,
  type FailureKind,
  type RetryState,
} from './retries.ts';
import { createWorkspace } from './workspaces.ts';

export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SELF_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export interface AgentInvocation {
  command: string;
  /** 默认 codex 的非交互参数；提示词经 stdin 传入。 */
  args?: string[];
  timeoutMs?: number;
}

export interface SelfCheckSpec {
  name: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface BuilderRunInput {
  goalId: string;
  workItemId: string;
  executor: Executor;
  /** 没有活跃工作区时用于自动创建；已有工作区时忽略。 */
  repoDir?: string;
  worktreeRoot?: string;
  agent?: AgentInvocation;
  /** 不传时按工作区里的 package.json 自动探测类型检查与测试。 */
  selfChecks?: SelfCheckSpec[];
  actor?: string;
}

export interface SelfCheckResult {
  name: string;
  status: ExecutorStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export type BuilderRunStatus = 'denied' | 'blocked' | 'skipped' | 'succeeded' | 'failed';

export interface BuilderRunResult {
  runId: string;
  status: BuilderRunStatus;
  reason: string;
  goalId: string;
  workItemId: string;
  workspaceId: string;
  branch: string;
  role: RoleInstance;
  agent: ExecutorResult | null;
  selfChecks: SelfCheckResult[];
  changedFiles: string[];
  diffStat: string;
  /** 本次运行前的重试状态，用于判断是否已接近转人阈值。 */
  retry: RetryState;
  /** 本次运行的失败分类；成功或未运行时为空。 */
  failureKind?: FailureKind;
}

/** 把目标、工作项与授权压成一段可执行提示词，避免 Agent 自行猜测边界。 */
export function buildBuilderPrompt(
  goal: Goal,
  plan: Plan,
  item: WorkItem,
  role: RoleInstance,
): string {
  const acceptance = goal.acceptance.map((line) => `- ${line}`).join('\n');
  const dod = item.dod.map((line) => `- ${line}`).join('\n');
  const paths = role.scope.paths?.join(', ') ?? '未限制';
  const boundaries = role.playbook.boundaries.map((line) => `- ${line}`).join('\n');

  return `你是 Super-Manner 的 Builder，请完成下面这一个工作项。

## 目标
标题：${goal.title}
仓库：${goal.repo}
验收标准：
${acceptance}

## 工作项
id：${item.id}
标题：${item.title}
完成标准：
${dod}
预算 token：${item.budgetTokens}（计划总预算 ${plan.totalBudgetTokens}）

## 授权范围
动作：${role.actions.join(', ')}
分支：${role.scope.branches?.join(', ') ?? '未限制'}
路径：${paths}

## 边界
${boundaries}
- 只在当前工作目录内修改文件
- 不要读取密钥、不要合并 PR、不要操作远端
- 不要提交（commit）或推送（push），提交由编排层统一处理

## 输出
用简短中文说明：改了什么、为什么、运行了哪些命令、结果如何。
如果无法完成，直接说明阻塞原因，不要伪造结果。`;
}

/** 从 package.json 探测自检命令；没有脚本时不强行运行。 */
export function detectSelfChecks(workspacePath: string): SelfCheckSpec[] {
  const packagePath = join(workspacePath, 'package.json');
  if (!existsSync(packagePath)) return [];

  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> })
      .scripts ?? {};
  } catch {
    return [];
  }

  const packageManager = existsSync(join(workspacePath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  const checks: SelfCheckSpec[] = [];
  if (scripts.typecheck) {
    checks.push({ name: 'typecheck', command: packageManager, args: ['run', 'typecheck'] });
  }
  if (scripts.test) {
    checks.push({ name: 'test', command: packageManager, args: ['run', 'test'] });
  }
  return checks;
}

/** 从检查点里取出上次写操作涉及的文件，跳过时仍能报告产物。 */
function checkpointFiles(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as { changedFiles?: unknown; files?: unknown };
  const files = Array.isArray(record.changedFiles) ? record.changedFiles : record.files;
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
}

/**
 * 运行一次 Builder。
 *
 * 顺序固定：装载角色 → 确认工作区 → 网关放行 repo.write → 调用 Agent → 自检 → 采集差异。
 * 网关不放行时不启动 Agent，保证"未授权不产生副作用"。
 */
export async function runBuilder(
  db: DatabaseSync,
  input: BuilderRunInput,
): Promise<BuilderRunResult> {
  const now = new Date();
  const goal = getGoalOrThrow(db, input.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能运行 Builder');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  const role = instantiateRole(db, {
    goalId: goal.id,
    workItemId: item.id,
    actor: input.actor,
  });

  const workspace =
    findActiveWorkspace(db, goal.id, item.id) ??
    (input.repoDir
      ? createWorkspace(db, {
          goalId: goal.id,
          workItemId: item.id,
          repoDir: input.repoDir,
          worktreeRoot: input.worktreeRoot,
          actor: input.actor,
        })
      : undefined);
  if (!workspace) {
    throw new Error(`工作项 ${item.id} 没有活跃工作区，请先创建或提供 repoDir`);
  }

  const runId = randomUUID();
  const retry = assessBuilderRetry(db, goal.id, item.id);

  // 暂停恢复后，已完成的写操作不再重放；返工（不通过判定或验收返工）会解除跳过。
  const repeat = assessRepeatWrite(db, goal.id, item.id);
  if (repeat.skip && repeat.checkpoint) {
    const reason = repeat.reason ?? '工作项已完成写操作，跳过重复执行';
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'builder.run_skipped',
        goalId: goal.id,
        subject: role.subject,
        payload: {
          runId,
          workItemId: item.id,
          checkpointId: repeat.checkpoint.id,
          checkpointKind: repeat.checkpoint.kind,
          reason,
        },
      },
      now.toISOString(),
    );
    return {
      runId,
      status: 'skipped',
      reason,
      goalId: goal.id,
      workItemId: item.id,
      workspaceId: workspace.id,
      branch: workspace.branch,
      role,
      agent: null,
      selfChecks: [],
      changedFiles: checkpointFiles(repeat.checkpoint.payload),
      diffStat: '',
      retry,
    };
  }

  if (retry.blocked) {
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'builder.retry_blocked',
        goalId: goal.id,
        subject: role.subject,
        payload: {
          runId,
          workItemId: item.id,
          sameCauseFailures: retry.sameCauseFailures,
          causeKey: retry.causeKey,
          reason: retry.reason,
        },
      },
      now.toISOString(),
    );
    return {
      runId,
      status: 'blocked',
      reason: retry.reason ?? '同一原因连续失败，已转人工处理',
      goalId: goal.id,
      workItemId: item.id,
      workspaceId: workspace.id,
      branch: workspace.branch,
      role,
      agent: null,
      selfChecks: [],
      changedFiles: [],
      diffStat: '',
      retry,
    };
  }

  const resource: ResourceRef = { repo: goal.repo, branch: workspace.branch };
  const pathScope = role.scope.paths?.[0];
  if (pathScope) resource.path = pathScope;

  const gate = requestAction(
    db,
    { action: 'repo.write', subject: role.subject, goalId: goal.id, resource },
    { now },
  );
  if (gate.outcome !== 'allowed') {
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'builder.run_denied',
        goalId: goal.id,
        subject: role.subject,
        payload: { runId, workItemId: item.id, reason: gate.reason, outcome: gate.outcome },
      },
      now.toISOString(),
    );
    return {
      runId,
      status: 'denied',
      reason: gate.reason,
      goalId: goal.id,
      workItemId: item.id,
      workspaceId: workspace.id,
      branch: workspace.branch,
      role,
      agent: null,
      selfChecks: [],
      changedFiles: [],
      diffStat: '',
      retry,
    };
  }

  const agent = input.agent ?? { command: 'codex', args: ['exec', '--sandbox', 'workspace-write'] };
  const timeoutMs = agent.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  appendAudit(
    db,
    {
      actor: input.actor ?? role.subject,
      type: 'builder.run_started',
      goalId: goal.id,
      subject: role.subject,
      payload: {
        runId,
        workItemId: item.id,
        workspaceId: workspace.id,
        branch: workspace.branch,
        agent: input.executor.name,
        command: agent.command,
      },
    },
    now.toISOString(),
  );

  const agentResult = await input.executor.run({
    command: agent.command,
    args: agent.args ?? [],
    cwd: workspace.path,
    stdin: buildBuilderPrompt(goal, plan, item, role),
    timeoutMs,
  });

  const selfChecks: SelfCheckResult[] = [];
  if (agentResult.status === 'succeeded') {
    const specs = input.selfChecks ?? detectSelfChecks(workspace.path);
    for (const spec of specs) {
      const result = await input.executor.run({
        command: spec.command,
        args: spec.args ?? [],
        cwd: workspace.path,
        timeoutMs: spec.timeoutMs ?? DEFAULT_SELF_CHECK_TIMEOUT_MS,
      });
      selfChecks.push({
        name: spec.name,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: tailText(result.stdout, 4000),
        stderr: tailText(result.stderr, 4000),
      });
    }
  }

  const changedFiles = listChangedFiles(workspace.path);
  const diffStat = runGit(['diff', '--stat'], { cwd: workspace.path }).stdout.trim();

  const failedChecks = selfChecks.filter((check) => check.status !== 'succeeded');
  // Agent 退出码为 0 但一个文件都没改，通常意味着它没真正执行；不能算成功。
  const noChanges = changedFiles.length === 0;
  const status: BuilderRunStatus =
    agentResult.status === 'succeeded' && failedChecks.length === 0 && !noChanges
      ? 'succeeded'
      : 'failed';
  const failure =
    classifyRunFailure(
      agentResult.status,
      failedChecks.map((check) => ({ name: check.name, status: check.status })),
      agentResult.stderr,
    ) ?? (status === 'failed' ? { failureKind: 'implementation' as const, causeKey: 'agent:no_changes' } : undefined);
  const reason =
    agentResult.status !== 'succeeded'
      ? `模型执行失败：${agentResult.status}（退出码 ${agentResult.exitCode ?? '无'}）`
      : failedChecks.length > 0
        ? `自检未通过：${failedChecks.map((check) => check.name).join(', ')}`
        : noChanges
          ? '执行完成但没有产生任何改动'
          : selfChecks.length > 0
            ? `执行成功，自检通过（${selfChecks.length}/${selfChecks.length}）`
            : '执行成功，未配置自检';

  const finishedAt = new Date().toISOString();
  appendAudit(
    db,
    {
      actor: input.actor ?? role.subject,
      type: 'builder.run_finished',
      goalId: goal.id,
      subject: role.subject,
      payload: {
        runId,
        workItemId: item.id,
        status,
        executorStatus: agentResult.status,
        exitCode: agentResult.exitCode,
        durationMs: agentResult.durationMs,
        ...(failure ?? {}),
        selfChecks: selfChecks.map((check) => ({
          name: check.name,
          status: check.status,
          exitCode: check.exitCode,
        })),
        changedFiles,
        diffStat,
        stdoutTail: tailText(agentResult.stdout),
        stderrTail: tailText(agentResult.stderr),
      },
    },
    finishedAt,
  );

  if (status === 'succeeded') {
    recordCheckpoint(db, {
      goalId: goal.id,
      workItemId: item.id,
      kind: 'builder_run',
      runId,
      payload: {
        workspaceId: workspace.id,
        branch: workspace.branch,
        changedFiles,
        diffStat,
      },
    });
  }

  return {
    runId,
    status,
    reason,
    goalId: goal.id,
    workItemId: item.id,
    workspaceId: workspace.id,
    branch: workspace.branch,
    role,
    agent: agentResult,
    selfChecks,
    changedFiles,
    diffStat,
    retry,
    ...(failure ? { failureKind: failure.failureKind } : {}),
  };
}