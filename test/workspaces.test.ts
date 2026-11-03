import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { branchNameFor, cleanupWorkspace, createWorkspace } from '../src/app/workspaces.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { runGit, runGitOrThrow } from '../src/infra/git.ts';
import { createTestDb, createTestGoal, setupApproved } from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function createRepo(): { root: string; repoDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'manner-workspace-'));
  tempRoots.push(root);
  const repoDir = join(root, 'demo');
  mkdirSync(repoDir);
  runGitOrThrow(['init', '-b', 'main'], { cwd: repoDir });
  runGitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  runGitOrThrow(['config', 'user.name', 'Tester'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# demo\n');
  runGitOrThrow(['add', '.'], { cwd: repoDir });
  runGitOrThrow(['commit', '-m', 'init'], { cwd: repoDir });
  return { root, repoDir };
}

test('分支命名落在 feature/sm-* 范围并包含工作项', () => {
  assert.equal(
    branchNameFor('3f2a9c1e-0000-4000-8000-000000000000', 'build'),
    'feature/sm-3f2a9c1e-build',
  );
  assert.equal(branchNameFor('abc', 'Build UI'), 'feature/sm-abc-build-ui');
  assert.match(branchNameFor('goal', 'verify'), /^feature\/sm-[a-z0-9]+-verify$/);
});

test('为工作项创建独立 worktree 并写入审计', () => {
  const { db, goal } = setupApproved();
  const { root, repoDir } = createRepo();

  const workspace = createWorkspace(db, {
    goalId: goal.id,
    workItemId: 'build',
    repoDir,
    worktreeRoot: join(root, 'worktrees'),
    actor: 'builder-1',
  });

  assert.equal(workspace.status, 'active');
  assert.equal(workspace.repo, 'acme/demo');
  assert.equal(workspace.branch, branchNameFor(goal.id, 'build'));
  assert.ok(existsSync(workspace.path));
  assert.equal(
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace.path }).stdout.trim(),
    workspace.branch,
  );

  // worktree 里的新文件不会出现在主工作树，工作项之间互不污染。
  writeFileSync(join(workspace.path, 'only-here.txt'), 'x');
  assert.equal(existsSync(join(repoDir, 'only-here.txt')), false);

  const events = listAuditEvents(db, goal.id).filter((event) => event.type === 'workspace.created');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject, 'builder-1');
});

test('同一工作项重复创建返回已有工作区', () => {
  const { db, goal } = setupApproved();
  const { root, repoDir } = createRepo();
  const input = {
    goalId: goal.id,
    workItemId: 'build',
    repoDir,
    worktreeRoot: join(root, 'worktrees'),
  };

  const first = createWorkspace(db, input);
  const second = createWorkspace(db, input);

  assert.equal(second.id, first.id);
  assert.equal(second.path, first.path);
});

test('不同工作项得到不同的 worktree 与分支', () => {
  const { db, goal } = setupApproved();
  const { root, repoDir } = createRepo();

  const build = createWorkspace(db, {
    goalId: goal.id,
    workItemId: 'build',
    repoDir,
    worktreeRoot: join(root, 'worktrees'),
  });
  const verify = createWorkspace(db, {
    goalId: goal.id,
    workItemId: 'verify',
    repoDir,
    worktreeRoot: join(root, 'worktrees'),
  });

  assert.notEqual(build.path, verify.path);
  assert.notEqual(build.branch, verify.branch);
  assert.ok(existsSync(build.path));
  assert.ok(existsSync(verify.path));
});

test('清理工作区会移除目录、删除分支并保留记录', () => {
  const { db, goal } = setupApproved();
  const { root, repoDir } = createRepo();
  const workspace = createWorkspace(db, {
    goalId: goal.id,
    workItemId: 'build',
    repoDir,
    worktreeRoot: join(root, 'worktrees'),
  });

  const removed = cleanupWorkspace(db, workspace.id, { actor: 'architect', deleteBranch: true });

  assert.equal(removed.status, 'removed');
  assert.ok(removed.removedAt);
  assert.equal(existsSync(workspace.path), false);
  assert.notEqual(
    runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: repoDir }).status,
    0,
  );

  const events = listAuditEvents(db, goal.id).filter((event) => event.type === 'workspace.removed');
  assert.equal(events.length, 1);
  assert.equal((events[0]?.payload as { branchDeleted: boolean }).branchDeleted, true);
});

test('未批准的目标不能创建工作区', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  assert.throws(
    () => createWorkspace(db, { goalId: goal.id, workItemId: 'build', repoDir: '/nonexistent' }),
    /不能创建工作区/,
  );
});

test('计划里不存在的工作项不能创建工作区', () => {
  const { db, goal } = setupApproved();
  assert.throws(
    () => createWorkspace(db, { goalId: goal.id, workItemId: 'nope', repoDir: '/nonexistent' }),
    /工作项不存在/,
  );
});