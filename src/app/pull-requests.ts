import type { DatabaseSync } from 'node:sqlite';
import type { Executor } from '../domain/executor.ts';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import { runGit } from '../infra/git.ts';
import { tailText } from '../infra/text.ts';
import { findActiveWorkspace } from '../infra/store.ts';
import { getGoalOrThrow } from './goals.ts';
import { requestAction } from './gateway.ts';
import { getApprovedPlan } from './plans.ts';
import { instantiateRole } from './roles.ts';

export interface CreatePullRequestInput {
  goalId: string;
  workItemId: string;
  executor: Executor;
  actor?: string;
  title?: string;
  body?: string;
  /** 目标分支，默认沿用工作区创建时的 base。 */
  base?: string;
  remote?: string;
}

export type PullRequestStatus = 'created' | 'existing' | 'denied' | 'blocked' | 'failed';

export interface PullRequestResult {
  status: PullRequestStatus;
  reason?: string;
  goalId: string;
  workItemId: string;
  repo: string;
  branch: string;
  base: string;
  remote: string;
  url?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  escalationId?: string;
}

const PR_URL_PATTERN = /https?:\/\/\S+\/pull\/\d+/;

function findExistingPullRequest(
  db: DatabaseSync,
  goalId: string,
  workItemId: string,
): { url: string } | null {
  const event = listAuditEvents(db, goalId).find((candidate) => {
    if (candidate.type !== 'pr.created') return false;
    const payload = candidate.payload as { workItemId?: string; url?: string } | null;
    return payload?.workItemId === workItemId && typeof payload.url === 'string';
  });
  const payload = event?.payload as { url?: string } | null;
  return payload?.url ? { url: payload.url } : null;
}

function defaultBody(goal: ReturnType<typeof getGoalOrThrow>, itemTitle: string, branch: string): string {
  const acceptance =
    goal.acceptance.length === 0
      ? '（未声明）'
      : goal.acceptance.map((line) => `- ${line}`).join('\n');
  return [
    `## 目标`,
    goal.title,
    '',
    `## 工作项`,
    itemTitle,
    '',
    `## 验收标准`,
    acceptance,
    '',
    '---',
    `由 manner 自动创建，分支 \`${branch}\`。`,
  ].join('\n');
}

/**
 * 用 gh CLI 为已推送的工作区分支创建 PR。
 *
 * - 必须经过 pr.create 网关授权；
 * - 同一工作项重复调用直接返回已创建的 PR（审计即幂等键）；
 * - 分支未推送时不调用 gh，避免产生空 PR。
 */
export async function createPullRequest(
  db: DatabaseSync,
  input: CreatePullRequestInput,
  now = new Date(),
): Promise<PullRequestResult> {
  const goal = getGoalOrThrow(db, input.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);
  const workspace = findActiveWorkspace(db, goal.id, item.id);
  if (!workspace) throw new Error(`工作项 ${item.id} 没有活跃工作区`);

  const role = instantiateRole(db, {
    goalId: goal.id,
    workItemId: item.id,
    actor: input.actor,
  });
  const base = input.base ?? workspace.baseBranch ?? goal.baseBranch;
  const remote = input.remote ?? 'origin';
  const baseResult = {
    goalId: goal.id,
    workItemId: item.id,
    repo: goal.repo,
    branch: workspace.branch,
    base,
    remote,
  };

  const existing = findExistingPullRequest(db, goal.id, item.id);
  if (existing) {
    return { ...baseResult, status: 'existing', url: existing.url, reason: '该工作项的 PR 已创建' };
  }

  const gate = requestAction(
    db,
    {
      action: 'pr.create',
      subject: role.subject,
      goalId: goal.id,
      resource: { repo: goal.repo, branch: workspace.branch },
    },
    { now },
  );
  if (gate.outcome !== 'allowed') {
    return {
      ...baseResult,
      status: 'denied',
      reason: gate.reason,
      ...(gate.escalationId === undefined ? {} : { escalationId: gate.escalationId }),
    };
  }

  const remoteRef = runGit(['ls-remote', '--heads', remote, workspace.branch], {
    cwd: workspace.path,
  });
  if (remoteRef.status !== 0) {
    return {
      ...baseResult,
      status: 'blocked',
      reason: `无法确认远端分支：${(remoteRef.stderr || remoteRef.stdout).trim() || `退出码 ${remoteRef.status}`}`,
    };
  }
  if (remoteRef.stdout.trim().length === 0) {
    return { ...baseResult, status: 'blocked', reason: `分支尚未推送到 ${remote}` };
  }

  const title = input.title ?? `${item.title} (${item.id})`;
  const body = input.body ?? defaultBody(goal, item.title, workspace.branch);
  const result = await input.executor.run({
    command: 'gh',
    args: [
      'pr',
      'create',
      '--repo',
      goal.repo,
      '--base',
      base,
      '--head',
      workspace.branch,
      '--title',
      title,
      '--body',
      body,
    ],
    cwd: workspace.path,
  });

  if (result.status !== 'succeeded') {
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'pr.create_failed',
        goalId: goal.id,
        subject: role.subject,
        payload: baseResult,
      },
      now.toISOString(),
    );
    return {
      ...baseResult,
      status: 'failed',
      reason: `gh pr create 失败：${result.status}`,
      exitCode: result.exitCode,
      stdout: tailText(result.stdout),
      stderr: tailText(result.stderr),
    };
  }

  const match = result.stdout.match(PR_URL_PATTERN);
  if (!match) {
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'pr.create_failed',
        goalId: goal.id,
        subject: role.subject,
        payload: { ...baseResult, reason: 'unparsable_output' },
      },
      now.toISOString(),
    );
    return {
      ...baseResult,
      status: 'failed',
      reason: 'gh 输出中没有可识别的 PR 链接',
      exitCode: result.exitCode,
      stdout: tailText(result.stdout),
      stderr: tailText(result.stderr),
    };
  }

  const url = match[0];
  appendAudit(
    db,
    {
      actor: input.actor ?? role.subject,
      type: 'pr.created',
      goalId: goal.id,
      subject: role.subject,
      payload: { ...baseResult, url, title },
    },
    now.toISOString(),
  );
  return {
    ...baseResult,
    status: 'created',
    url,
    exitCode: result.exitCode,
    stdout: tailText(result.stdout),
    stderr: tailText(result.stderr),
  };
}