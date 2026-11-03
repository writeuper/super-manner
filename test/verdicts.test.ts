import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBuilder } from '../src/app/builder.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { getLatestVerdicts, recordVerdicts } from '../src/app/verdicts.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { createTestRepo, setupApproved } from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const ACCEPTANCE = ['错误密码时展示提示文案', '不泄露账号是否存在'];
const DOD = ['改动通过类型检查', '覆盖失败路径'];

class FakeExecutor implements Executor {
  readonly name = 'fake';
  private readonly handler: (request: ExecutorRequest) => Partial<ExecutorResult>;

  constructor(handler: (request: ExecutorRequest) => Partial<ExecutorResult> = () => ({})) {
    this.handler = handler;
  }

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
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

async function withWorkspaceEvidence(): Promise<{
  db: ReturnType<typeof setupApproved>['db'];
  goalId: string;
  evidenceId: string;
}> {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor((request) => {
      if (request.command === 'fake-agent') {
        writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
      }
      return { stdout: '自检通过' };
    }),
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });

  const collection = await collectEvidence(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
  const evidenceId = collection.evidence[0]?.id;
  assert.ok(evidenceId);
  return { db, goalId: goal.id, evidenceId };
}

test('逐条判定覆盖全部标准并保留历史', async () => {
  const { db, goalId, evidenceId } = await withWorkspaceEvidence();

  const first = recordVerdicts(
    db,
    {
      goalId,
      workItemId: 'build',
      verdicts: [
        { criterion: ACCEPTANCE[0] as string, result: 'passed', note: '差异中有错误文案', evidence: [evidenceId] },
        { criterion: ACCEPTANCE[1] as string, result: 'undetermined', note: '缺少对账号枚举的测试' },
        { criterion: DOD[0] as string, result: 'passed', note: 'typecheck 退出码 0' },
        { criterion: DOD[1] as string, result: 'passed', note: '已覆盖失败分支' },
      ],
      actor: 'verifier-1',
    },
    new Date('2026-11-03T11:00:00.000Z'),
  );

  assert.equal(first.recordedAt, '2026-11-03T11:00:00.000Z');
  assert.deepEqual(first.summary, {
    total: 4,
    passed: 3,
    failed: 0,
    undetermined: 1,
    complete: false,
  });

  const second = recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [ACCEPTANCE[0], ACCEPTANCE[1], DOD[0], DOD[1]].map((criterion) => ({
      criterion: criterion as string,
      result: 'passed' as const,
      note: '复核通过',
    })),
  });
  assert.equal(second.summary.complete, true);

  const latest = getLatestVerdicts(db, goalId, 'build');
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.summary.complete, true);

  const recorded = listAuditEvents(db, goalId).filter(
    (event) => event.type === 'verifier.verdicts_recorded',
  );
  assert.equal(recorded.length, 2);
  assert.equal((recorded[0]?.payload as { summary: { complete: boolean } }).summary.complete, false);
});

test('缺条目、未知标准、重复与空说明都被拒绝', async () => {
  const { db, goalId } = await withWorkspaceEvidence();
  const full = [ACCEPTANCE[0], ACCEPTANCE[1], DOD[0], DOD[1]] as string[];

  assert.throws(
    () =>
      recordVerdicts(db, {
        goalId,
        workItemId: 'build',
        verdicts: [{ criterion: full[0] as string, result: 'passed', note: '只判定一条' }],
      }),
    /尚未给出结论/,
  );

  assert.throws(
    () =>
      recordVerdicts(db, {
        goalId,
        workItemId: 'build',
        verdicts: [...full, '额外的标准'].map((criterion) => ({
          criterion,
          result: 'passed' as const,
          note: '说明',
        })),
      }),
    /不在目标验收或工作项完成标准内/,
  );

  assert.throws(
    () =>
      recordVerdicts(db, {
        goalId,
        workItemId: 'build',
        verdicts: [...full, full[0] as string].map((criterion) => ({
          criterion,
          result: 'passed' as const,
          note: '说明',
        })),
      }),
    /不能重复判定/,
  );

  assert.throws(
    () =>
      recordVerdicts(db, {
        goalId,
        workItemId: 'build',
        verdicts: full.map((criterion) => ({
          criterion,
          result: 'passed' as const,
          note: '  ',
        })),
      }),
    /缺少说明/,
  );

  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'verifier.verdicts_recorded').length,
    0,
  );
});

test('引用不存在的证据被拒绝', async () => {
  const { db, goalId } = await withWorkspaceEvidence();
  const full = [ACCEPTANCE[0], ACCEPTANCE[1], DOD[0], DOD[1]] as string[];

  assert.throws(
    () =>
      recordVerdicts(db, {
        goalId,
        workItemId: 'build',
        verdicts: full.map((criterion) => ({
          criterion,
          result: 'passed' as const,
          note: '说明',
          evidence: ['not-a-real-evidence'],
        })),
      }),
    /引用的证据不存在/,
  );
});