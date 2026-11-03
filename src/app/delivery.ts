import type { DatabaseSync } from 'node:sqlite';
import type { Goal, ResourceRef, WorkItem } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { listChangedFiles, runGit, runGitOrThrow } from '../infra/git.ts';
import { findActiveWorkspace } from '../infra/store.ts';
import { tailText } from '../infra/text.ts';
import { getGoalOrThrow } from './goals.ts';
import { requestAction } from './gateway.ts';
import { getApprovedPlan } from './plans.ts';
import { instantiateRole } from './roles.ts';

export interface DeliveryInput {
  goalId: string;
  workItemId: string;
  actor?: string;
}

export interface CommitWorkspaceInput extends DeliveryInput {
  message?: string;
}

export type CommitStatus = 'committed' | 'denied' | 'no_changes';

export interface CommitWorkspaceResult {
  status: CommitStatus;
  reason?: string;
  goalId: string;
  workItemId: string;
  workspaceId: string;
  branch: string;
  files: string[];
  sha?: string;
  message?: string;
}

export interface PushWorkspaceInput extends DeliveryInput {
  remote?: string;
}

export type PushStatus = 'pushed' | 'denied' | 'failed';

export interface PushWorkspaceResult {
  status: PushStatus;
  reason?: string;
  goalId: string;
  workItemId: string;
  workspaceId: string;
  branch: string;
  remote: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface DeliveryContext {
  goal: Goal;
  item: WorkItem;
  workspaceId: string;
  workspacePath: string;
  branch: string;
}

function requireContext(db: DatabaseSync, input: DeliveryInput): DeliveryContext {
  const goal = getGoalOrThrow(db, input.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);
  const workspace = findActiveWorkspace(db, goal.id, item.id);
  if (!workspace) throw new Error(`工作项 ${item.id} 没有活跃工作区`);
  return {
    goal,
    item,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    branch: workspace.branch,
  };
}

/** 提交前校验所有改动都在授权路径内，避免 Agent 顺手改了范围外的文件。 */
function assertWithinScope(item: WorkItem, files: string[]): void {
  const paths = item.grant.scope.paths;
  if (!paths || paths.length === 0) return;
  const outside = files.filter(
    (file) =>
      !paths.some((prefix) =>
        file === prefix ? true : file.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
      ),
  );
  if (outside.length > 0) {
    throw new Error(`改动超出授权路径：${outside.join(', ')}`);
  }
}

/** 把工作区改动提交到自有分支；未获 repo.commit 授权时不写任何 git 状态。 */
export function commitWorkspace(
  db: DatabaseSync,
  input: CommitWorkspaceInput,
  now = new Date(),
): CommitWorkspaceResult {
  const context = requireContext(db, input);
  const role = instantiateRole(db, {
    goalId: context.goal.id,
    workItemId: context.item.id,
    actor: input.actor,
  });

  const files = listChangedFiles(context.workspacePath);
  if (files.length === 0) {
    return {
      status: 'no_changes',
      goalId: context.goal.id,
      workItemId: context.item.id,
      workspaceId: context.workspaceId,
      branch: context.branch,
      files,
    };
  }
  assertWithinScope(context.item, files);

  const resource: ResourceRef = { repo: context.goal.repo, branch: context.branch };
  const pathScope = role.scope.paths?.[0];
  if (pathScope) resource.path = pathScope;

  const gate = requestAction(
    db,
    {
      action: 'repo.commit',
      subject: role.subject,
      goalId: context.goal.id,
      resource,
    },
    { now },
  );
  if (gate.outcome !== 'allowed') {
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'builder.commit_denied',
        goalId: context.goal.id,
        subject: role.subject,
        payload: { workItemId: context.item.id, reason: gate.reason, outcome: gate.outcome },
      },
      now.toISOString(),
    );
    return {
      status: 'denied',
      reason: gate.reason,
      goalId: context.goal.id,
      workItemId: context.item.id,
      workspaceId: context.workspaceId,
      branch: context.branch,
      files,
    };
  }

  const message = input.message ?? `manner: ${context.item.title} (${context.item.id})`;
  runGitOrThrow(['add', '-A'], { cwd: context.workspacePath });
  runGitOrThrow(['commit', '-m', message], { cwd: context.workspacePath });
  const sha = runGit(['rev-parse', 'HEAD'], { cwd: context.workspacePath }).stdout.trim();

  appendAudit(
    db,
    {
      actor: input.actor ?? role.subject,
      type: 'builder.committed',
      goalId: context.goal.id,
      subject: role.subject,
      payload: {
        workItemId: context.item.id,
        branch: context.branch,
        sha,
        message,
        files: files.slice(0, 50),
      },
    },
    new Date().toISOString(),
  );

  return {
    status: 'committed',
    goalId: context.goal.id,
    workItemId: context.item.id,
    workspaceId: context.workspaceId,
    branch: context.branch,
    files,
    sha,
    message,
  };
}

/** 推送自有分支；PR 创建在 P0 由人工完成，这里只保证分支可达。 */
export function pushWorkspace(
  db: DatabaseSync,
  input: PushWorkspaceInput,
  now = new Date(),
): PushWorkspaceResult {
  const context = requireContext(db, input);
  const role = instantiateRole(db, {
    goalId: context.goal.id,
    workItemId: context.item.id,
    actor: input.actor,
  });
  const remote = input.remote ?? 'origin';

  const gate = requestAction(
    db,
    {
      action: 'repo.push',
      subject: role.subject,
      goalId: context.goal.id,
      resource: { repo: context.goal.repo, branch: context.branch },
    },
    { now },
  );
  if (gate.outcome !== 'allowed') {
    appendAudit(
      db,
      {
        actor: input.actor ?? role.subject,
        type: 'builder.push_denied',
        goalId: context.goal.id,
        subject: role.subject,
        payload: { workItemId: context.item.id, branch: context.branch, reason: gate.reason, outcome: gate.outcome },
      },
      now.toISOString(),
    );
    return {
      status: 'denied',
      reason: gate.reason,
      goalId: context.goal.id,
      workItemId: context.item.id,
      workspaceId: context.workspaceId,
      branch: context.branch,
      remote,
      exitCode: null,
      stdout: '',
      stderr: '',
    };
  }

  const result = runGit(['push', '-u', remote, context.branch], { cwd: context.workspacePath });
  const status: PushStatus = result.status === 0 ? 'pushed' : 'failed';
  const stdout = tailText(result.stdout.trim());
  const stderr = tailText(result.stderr.trim());

  appendAudit(
    db,
    {
      actor: input.actor ?? role.subject,
      type: 'builder.pushed',
      goalId: context.goal.id,
      subject: role.subject,
      payload: {
        workItemId: context.item.id,
        branch: context.branch,
        remote,
        status,
        exitCode: result.status,
        stdout,
        stderr,
      },
    },
    new Date().toISOString(),
  );

  return {
    status,
    reason: status === 'failed' ? stderr || `git push 退出码 ${result.status}` : undefined,
    goalId: context.goal.id,
    workItemId: context.item.id,
    workspaceId: context.workspaceId,
    branch: context.branch,
    remote,
    exitCode: result.status,
    stdout,
    stderr,
  };
}