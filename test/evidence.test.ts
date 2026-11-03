import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBuilder } from '../src/app/builder.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { createTestRepo, setupApproved } from './helpers.ts';

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
      startedAt: '2026-11-03T10:00:00.000Z',
      endedAt: '2026-11-03T10:00:01.000Z',
      durationMs: 1000,
      ...this.handler(request),
    };
  }
}

test('证据记录命令、环境、时间与哈希，他人可据此重跑', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  const agentExecutor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
    }
    return {};
  });
  await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: agentExecutor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });

  const executor = new FakeExecutor((request) =>
    request.command === 'fake-verify'
      ? { status: 'failed', exitCode: 1, stdout: '断言失败', stderr: 'expected true' }
      : { stdout: '类型检查通过' },
  );

  const collection = await collectEvidence(
    db,
    {
      goalId: goal.id,
      workItemId: 'build',
      executor,
      checks: [
        { name: 'typecheck', command: 'fake-typecheck', args: ['--noEmit'] },
        { name: 'verify', command: 'fake-verify' },
      ],
      actor: 'verifier-1',
    },
    new Date('2026-11-03T10:05:00.000Z'),
  );

  assert.equal(collection.goalId, goal.id);
  assert.equal(collection.workItemId, 'build');
  assert.equal(collection.collectedAt, '2026-11-03T10:05:00.000Z');
  assert.match(collection.branch, /^feature\/sm-.+-build$/);
  assert.match(collection.head, /^[0-9a-f]{40}$/);
  assert.equal(collection.evidence.length, 2);

  const [passed, failed] = collection.evidence;
  assert.ok(passed && failed);
  assert.equal(passed.name, 'typecheck');
  assert.deepEqual(passed.args, ['--noEmit']);
  assert.equal(passed.status, 'succeeded');
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.startedAt, '2026-11-03T10:00:00.000Z');
  assert.equal(passed.startedAt <= passed.endedAt, true);
  assert.equal(passed.cwd, collection.evidence[0]?.cwd);
  assert.equal(passed.env.branch, collection.branch);
  assert.equal(passed.env.head, collection.head);
  assert.equal(passed.env.platform, process.platform);
  assert.match(passed.env.node, /^v\d+/);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /expected true/);

  // 哈希覆盖命令与完整输出，凭记录即可重算核对。
  const expectedHash = createHash('sha256')
    .update(`${failed.command} ${failed.args.join(' ')}\n${failed.stdout}\n${failed.stderr}`)
    .digest('hex');
  assert.equal(failed.hash, expectedHash);
  assert.equal(executor.calls[0]?.cwd, collection.evidence[0]?.cwd);
  assert.equal(executor.calls[1]?.timeoutMs, 10 * 60 * 1000);

  const collected = listAuditEvents(db, goal.id).find(
    (event) => event.type === 'verifier.evidence_collected',
  );
  assert.ok(collected);
  const payload = collected.payload as {
    workspaceId: string;
    head: string;
    evidence: Array<{ hash: string }>;
  };
  assert.equal(payload.workspaceId, collection.workspaceId);
  assert.equal(payload.head, collection.head);
  assert.deepEqual(
    payload.evidence.map((record) => record.hash),
    collection.evidence.map((record) => record.hash),
  );
});

test('没有活跃工作区时不能采集证据', async () => {
  const { db, goal } = setupApproved();
  await assert.rejects(
    () =>
      collectEvidence(db, {
        goalId: goal.id,
        workItemId: 'build',
        executor: new FakeExecutor(),
        checks: [],
      }),
    /没有活跃工作区/,
  );
});