import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commitWorkspace, pushWorkspace } from '../src/app/delivery.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { createWorkspace } from '../src/app/workspaces.ts';
import type { Action } from '../src/domain/actions.ts';
import type { Workspace } from '../src/domain/types.ts';
import type { DatabaseSync } from 'node:sqlite';
import { listAuditEvents } from '../src/infra/audit.ts';
import { runGit, runGitOrThrow } from '../src/infra/git.ts';
import {
  BUILDER,
  REPO,
  builderItem,
  createTestDb,
  createTestGoal,
  createTestRepo,
  defaultPlan,
  type TestRepo,
} from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

interface DeliveryFixture {
  db: DatabaseSync;
  goalId: string;
  repo: TestRepo;
  workspace: Workspace;
}

function setupWorkspace(
  options: { actions?: Action[]; bareRemote?: boolean } = {},
): DeliveryFixture {
  const actions = options.actions ?? ['repo.read', 'repo.write', 'repo.commit', 'repo.push'];
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(
    db,
    goal.id,
    defaultPlan({
      workItems: [
        builderItem({
          grant: {
            subject: BUILDER,
            actions,
            scope: { repos: [REPO], branches: ['feature/sm-*'], paths: ['src/'] },
            constraints: {},
          },
        }),
      ],
    }),
    'planner',
  );
  approvePlan(db, plan.id, 'architect');

  const repo = createTestRepo({ bareRemote: options.bareRemote });
  tempRoots.push(repo.root);
  const workspace = createWorkspace(db, {
    goalId: goal.id,
    workItemId: 'build',
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
  });
  return { db, goalId: goal.id, repo, workspace };
}

function writeChange(workspace: Workspace, file = 'src/login.ts'): void {
  writeFileSync(join(workspace.path, file), 'export const login = true;\n');
}

function headOf(workspace: Workspace): string {
  return runGit(['rev-parse', 'HEAD'], { cwd: workspace.path }).stdout.trim();
}

test('提交授权范围内的改动并写入审计', () => {
  const { db, goalId, workspace } = setupWorkspace();
  writeChange(workspace);

  const result = commitWorkspace(db, {
    goalId,
    workItemId: 'build',
    message: 'feat: show login error',
  });

  assert.equal(result.status, 'committed');
  assert.deepEqual(result.files, ['src/login.ts']);
  assert.match(result.sha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(headOf(workspace), result.sha);
  assert.equal(
    runGit(['log', '-1', '--pretty=%s'], { cwd: workspace.path }).stdout.trim(),
    'feat: show login error',
  );
  assert.equal(runGit(['status', '--porcelain'], { cwd: workspace.path }).stdout.trim(), '');
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'builder.committed').length,
    1,
  );
});

test('没有改动时返回 no_changes 且不创建提交', () => {
  const { db, goalId, workspace } = setupWorkspace();
  const before = headOf(workspace);

  const result = commitWorkspace(db, { goalId, workItemId: 'build' });

  assert.equal(result.status, 'no_changes');
  assert.equal(result.sha, undefined);
  assert.equal(headOf(workspace), before);
});

test('改动超出授权路径时拒绝提交', () => {
  const { db, goalId, workspace } = setupWorkspace();
  writeFileSync(join(workspace.path, 'README.md'), '# changed\n');
  const before = headOf(workspace);

  assert.throws(
    () => commitWorkspace(db, { goalId, workItemId: 'build' }),
    /改动超出授权路径：README\.md/,
  );
  assert.equal(headOf(workspace), before);
});

test('未获 repo.commit 授权时不写入 git 状态', () => {
  const { db, goalId, workspace } = setupWorkspace({ actions: ['repo.read', 'repo.write'] });
  writeChange(workspace);
  const before = headOf(workspace);

  const result = commitWorkspace(db, { goalId, workItemId: 'build' });

  assert.equal(result.status, 'denied');
  assert.match(result.reason ?? '', /没有覆盖该动作的授权/);
  assert.equal(headOf(workspace), before);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'builder.commit_denied').length,
    1,
  );
});

test('推送自有分支到远端', () => {
  const { db, goalId, repo, workspace } = setupWorkspace({ bareRemote: true });
  writeChange(workspace);
  const commit = commitWorkspace(db, { goalId, workItemId: 'build' });
  assert.equal(commit.status, 'committed');

  const result = pushWorkspace(db, { goalId, workItemId: 'build' });

  assert.equal(result.status, 'pushed');
  assert.equal(result.remote, 'origin');
  const remoteRef = runGit(['--git-dir', repo.remoteDir, 'rev-parse', '--verify', `refs/heads/${workspace.branch}`]);
  assert.equal(remoteRef.status, 0);
  assert.equal(remoteRef.stdout.trim(), commit.sha);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'builder.pushed').length,
    1,
  );
});

test('未获 repo.push 授权时不推送', () => {
  const { db, goalId, repo, workspace } = setupWorkspace({
    actions: ['repo.read', 'repo.write', 'repo.commit'],
    bareRemote: true,
  });
  writeChange(workspace);
  commitWorkspace(db, { goalId, workItemId: 'build' });

  const result = pushWorkspace(db, { goalId, workItemId: 'build' });

  assert.equal(result.status, 'denied');
  assert.match(result.reason ?? '', /没有覆盖该动作的授权/);
  assert.notEqual(
    runGit(['--git-dir', repo.remoteDir, 'rev-parse', '--verify', `refs/heads/${workspace.branch}`]).status,
    0,
  );
});

test('远端不可达时推送标记为失败', () => {
  const { db, goalId, repo, workspace } = setupWorkspace({ bareRemote: true });
  runGitOrThrow(['remote', 'set-url', 'origin', join(repo.root, 'missing.git')], { cwd: repo.repoDir });

  const result = pushWorkspace(db, { goalId, workItemId: 'build' });

  assert.equal(result.status, 'failed');
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => (event.payload as { status?: string }).status === 'failed')
      .length,
    1,
  );
});