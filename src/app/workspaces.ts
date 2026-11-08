import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Goal, Workspace } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { branchExists, isGitRepository, runGit, runGitOrThrow } from '../infra/git.ts';
import {
  findActiveWorkspace,
  getWorkspace,
  insertWorkspace,
  markWorkspaceRemoved,
} from '../infra/store.ts';
import { getGoalOrThrow } from './goals.ts';
import { getApprovedPlan } from './plans.ts';

/** 工作区的分支命名同时满足授权里的 `feature/sm-*` 范围。 */
export function branchNameFor(goalId: string, workItemId: string): string {
  const goalPart = sanitize(goalId.replace(/-/g, '').slice(0, 8));
  return `feature/sm-${goalPart}-${sanitize(workItemId)}`;
}

/**
 * 下游工作项的起始分支：取最后一个上游工作项的分支，确保能看到上游交付。
 * 多前置合并暂不在 P1 实现范围内，先按单链处理。
 */
export function dependencyBaseBranch(
  goalId: string,
  item: { dependsOn: string[] },
  repoDir: string,
  fallback: string,
): string {
  const dependencyId = item.dependsOn.at(-1);
  if (!dependencyId) return fallback;
  const branch = branchNameFor(goalId, dependencyId);
  if (!branchExists(repoDir, branch)) {
    throw new Error(`上游工作项 ${dependencyId} 的分支不存在：${branch}`);
  }
  return branch;
}

function sanitize(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || 'item';
}









export interface CreateWorkspaceInput {
  goalId: string;
  workItemId: string;
  /** 本地 git 克隆路径，工作项从这里拉出独立 worktree。 */
  repoDir: string;
  /** 默认放在仓库同级的 .manner-worktrees/<repo>/ 下，避免污染仓库工作树。 */
  worktreeRoot?: string;
  /** 默认取目标的 baseBranch。 */
  baseBranch?: string;
  actor?: string;
}

/**
 * 为工作项创建独立 worktree。
 *
 * 同一工作项重复调用返回已有活跃工作区，避免并发工作项互相污染。
 * 所有 git 操作失败都会显式报错；创建后写库失败会回滚 worktree。
 */
export function createWorkspace(
  db: DatabaseSync,
  input: CreateWorkspaceInput,
  now = new Date(),
): Workspace {
  const goal = getGoalOrThrow(db, input.goalId);
  if (goal.status !== 'executing' && goal.status !== 'verifying') {
    throw new Error(`目标当前状态不能创建工作区：${goal.status}`);
  }

  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能创建工作区');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  const existing = findActiveWorkspace(db, goal.id, item.id);
  if (existing) return existing;

  const repoDir = resolve(input.repoDir);
  if (!isGitRepository(repoDir)) {
    throw new Error(`不是 git 仓库：${repoDir}`);
  }

  const baseBranch = input.baseBranch ?? goal.baseBranch;
  const branch = branchNameFor(goal.id, item.id);
  if (branchExists(repoDir, branch)) {
    throw new Error(`分支已存在：${branch}；请先清理残留 worktree 或分支`);
  }

  const worktreeRoot = resolve(
    input.worktreeRoot ?? join(dirname(repoDir), '.manner-worktrees', basename(repoDir)),
  );
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreePath = join(worktreeRoot, bucketName(goal, item.id));
  if (existsSync(worktreePath)) {
    throw new Error(`worktree 目录已存在：${worktreePath}`);
  }

  runGitOrThrow(['worktree', 'add', '-b', branch, worktreePath, baseBranch], { cwd: repoDir });

  const workspace: Workspace = {
    id: randomUUID(),
    goalId: goal.id,
    workItemId: item.id,
    repo: goal.repo,
    repoDir,
    baseBranch,
    branch,
    path: worktreePath,
    status: 'active',
    createdAt: now.toISOString(),
  };

  try {
    insertWorkspace(db, workspace);
  } catch (error) {
    runGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoDir });
    throw error;
  }

  appendAudit(
    db,
    {
      actor: input.actor ?? 'system',
      type: 'workspace.created',
      goalId: goal.id,
      subject: item.grant.subject,
      payload: {
        workspaceId: workspace.id,
        workItemId: item.id,
        repo: workspace.repo,
        branch,
        path: worktreePath,
      },
    },
    workspace.createdAt,
  );

  return workspace;
}

function bucketName(goal: Goal, workItemId: string): string {
  return `${sanitize(goal.id.replace(/-/g, '').slice(0, 8))}-${sanitize(workItemId)}`;
}

export interface CleanupWorkspaceOptions {
  actor?: string;
  /** 同时删除本地分支；分支若已推送，远端不受影响。 */
  deleteBranch?: boolean;
  /** worktree 有未提交改动时强制移除。 */
  force?: boolean;
}

/** 清理工作区：移除 worktree、按需删除分支，并把记录标记为 removed。 */
export function cleanupWorkspace(
  db: DatabaseSync,
  workspaceId: string,
  options: CleanupWorkspaceOptions = {},
  now = new Date(),
): Workspace {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) throw new Error(`工作区不存在：${workspaceId}`);
  if (workspace.status === 'removed') return workspace;

  const at = now.toISOString();
  if (existsSync(workspace.path)) {
    runGitOrThrow(
      ['worktree', 'remove', ...(options.force ? ['--force'] : []), workspace.path],
      { cwd: workspace.repoDir },
    );
  }
  runGit(['worktree', 'prune'], { cwd: workspace.repoDir });

  let branchDeleted = false;
  if (options.deleteBranch) {
    branchDeleted = runGit(['branch', '-D', workspace.branch], { cwd: workspace.repoDir }).status === 0;
  }

  markWorkspaceRemoved(db, workspace.id, at);
  appendAudit(
    db,
    {
      actor: options.actor ?? 'system',
      type: 'workspace.removed',
      goalId: workspace.goalId,
      subject: workspace.id,
      payload: {
        workspaceId: workspace.id,
        workItemId: workspace.workItemId,
        branch: workspace.branch,
        path: workspace.path,
        branchDeleted,
      },
    },
    at,
  );

  return { ...workspace, status: 'removed', removedAt: at };
}