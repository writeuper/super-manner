import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detectSelfChecks, runBuilder } from '../src/app/builder.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import type { WorkItem } from '../src/domain/types.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import {
  BUILDER,
  REPO,
  builderItem,
  createTestDb,
  createTestGoal,
  createTestRepo,
  defaultPlan,
  setupApproved,
} from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** 记录调用并按需返回结果的假执行器，避免测试依赖真实模型 CLI。 */
class FakeExecutor implements Executor {
  readonly name = 'fake';
  calls: ExecutorRequest[] = [];
  private readonly handler: (request: ExecutorRequest) => Partial<ExecutorResult>;

  constructor(handler: (request: ExecutorRequest) => Partial<ExecutorResult> = () => ({})) {
    this.handler = handler;
  }

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    this.calls.push(request);
    return {
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      ...this.handler(request),
    };
  }
}

function approvedWithBuilderItem(item: WorkItem): { db: ReturnType<typeof createTestDb>; goalId: string } {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(db, goal.id, defaultPlan({ workItems: [item] }), 'planner');
  approvePlan(db, plan.id, 'architect');
  return { db, goalId: goal.id };
}

test('Builder 在授权工作区内运行 Agent、自检并采集差异', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      assert.match(request.stdin ?? '', /## 工作项/);
      assert.match(request.stdin ?? '', /不要提交（commit）/);
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
      return { stdout: '已新增登录错误提示' };
    }
    return { stdout: `${request.command} ok` };
  });

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [
      { name: 'typecheck', command: 'fake-typecheck' },
      { name: 'test', command: 'fake-test' },
    ],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.reason, '执行成功，自检通过（2/2）');
  assert.deepEqual(result.changedFiles, ['src/login.ts']);
  assert.deepEqual(
    result.selfChecks.map((check) => check.name),
    ['typecheck', 'test'],
  );
  assert.equal(result.role.role, 'builder');
  assert.equal(executor.calls[0]?.command, 'fake-agent');
  assert.ok(executor.calls[0]?.cwd?.startsWith(join(repo.root, 'worktrees')));

  const types = listAuditEvents(db, goal.id).map((event) => event.type);
  assert.ok(types.includes('builder.run_started'));
  assert.ok(types.includes('builder.run_finished'));
});

test('没有 repo.write 授权时不启动 Agent', async () => {
  const { db, goalId } = approvedWithBuilderItem(
    builderItem({
      grant: {
        subject: BUILDER,
        actions: ['repo.read'],
        scope: { repos: [REPO], branches: ['feature/sm-*'], paths: ['src/'] },
        constraints: {},
      },
    }),
  );
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor();

  const result = await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
  });

  assert.equal(result.status, 'denied');
  assert.match(result.reason, /没有覆盖该动作的授权/);
  assert.equal(executor.calls.length, 0);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'builder.run_denied').length,
    1,
  );
});

test('Agent 失败时不运行自检并返回失败原因', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) =>
    request.command === 'fake-agent'
      ? { status: 'failed', exitCode: 2, stderr: '模型无法完成' }
      : {},
  );

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /模型执行失败：failed/);
  assert.equal(result.selfChecks.length, 0);
  assert.equal(executor.calls.length, 1);
});

test('自检失败时整体判定为失败', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) =>
    request.command === 'fake-typecheck'
      ? { status: 'failed', exitCode: 1, stderr: '类型错误' }
      : { stdout: 'ok' },
  );

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /自检未通过：typecheck/);
});

test('没有活跃工作区且未提供仓库路径时拒绝运行', async () => {
  const { db, goal } = setupApproved();
  await assert.rejects(
    () =>
      runBuilder(db, {
        goalId: goal.id,
        workItemId: 'build',
        executor: new FakeExecutor(),
        agent: { command: 'fake-agent' },
      }),
    /没有活跃工作区/,
  );
});

test('自检命令按 package.json 与锁文件探测', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manner-checks-'));
  tempRoots.push(dir);
  assert.deepEqual(detectSelfChecks(dir), []);

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test', lint: 'eslint .' } }),
  );
  assert.deepEqual(detectSelfChecks(dir), [
    { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
    { name: 'test', command: 'npm', args: ['run', 'test'] },
  ]);

  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  assert.deepEqual(
    detectSelfChecks(dir).map((check) => check.command),
    ['pnpm', 'pnpm'],
  );
});