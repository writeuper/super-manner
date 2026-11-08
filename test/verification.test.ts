import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBuilder } from '../src/app/builder.ts';
import { commitWorkspace } from '../src/app/delivery.ts';
import { getGoalOrThrow, setGoalStatus } from '../src/app/goals.ts';
import { buildVerifierContext, startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { setupApproved, createTestRepo } from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

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

test('验证上下文只含目标、标准与差异，不含实现过程', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      writeFileSync(
        join(request.cwd as string, 'src', 'login.ts'),
        'export const login = (password: string) => password.length > 0;\n',
      );
      return { stdout: 'IMPLEMENTATION-ONLY-SECRET 我改了登录逻辑' };
    }
    return {};
  });

  await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
  assert.equal(commitWorkspace(db, { goalId: goal.id, workItemId: 'build' }).status, 'committed');
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });

  const context = buildVerifierContext(db, { goalId: goal.id, workItemId: 'build' });

  assert.match(context.prompt, /错误密码时展示提示文案/);
  assert.match(context.prompt, /不泄露账号是否存在/);
  assert.match(context.prompt, /改动通过类型检查|覆盖失败路径/);
  assert.match(context.prompt, /src\/login\.ts/);
  assert.match(context.prompt, /export const login/);
  assert.doesNotMatch(context.prompt, /IMPLEMENTATION-ONLY-SECRET/);
  assert.doesNotMatch(context.prompt, /我改了登录逻辑/);
  assert.deepEqual(context.changedFiles, ['src/login.ts']);
  assert.equal(context.diffTruncated, false);
  assert.match(context.promptHash, /^[0-9a-f]{64}$/);

  const events = listAuditEvents(db, goal.id);
  const built = events.find((event) => event.type === 'verifier.context_built');
  assert.ok(built);
  const payload = built.payload as { promptHash: string; changedFiles: string[] };
  assert.equal(payload.promptHash, context.promptHash);
  assert.deepEqual(payload.changedFiles, ['src/login.ts']);
});

test('没有活跃工作区时不能构建验证上下文', () => {
  const { db, goal } = setupApproved();
  setGoalStatus(db, getGoalOrThrow(db, goal.id), 'verifying', 'verifier-1');
  assert.throws(
    () => buildVerifierContext(db, { goalId: goal.id, workItemId: 'build' }),
    /没有活跃工作区/,
  );
});