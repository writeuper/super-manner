import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { runBuilder } from '../src/app/builder.ts';
import { assessCompletion } from '../src/app/completion.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import {
  builderItem,
  createTestGoal,
  createTestDb,
  createTestRepo,
  defaultPlan,
  setupApproved,
} from './helpers.ts';

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

function singleItemPlan(): { db: ReturnType<typeof createTestDb>; goalId: string } {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(db, goal.id, defaultPlan({ workItems: [builderItem()], totalBudgetTokens: 1000 }), 'planner');
  approvePlan(db, plan.id, 'architect');
  return { db, goalId: goal.id };
}

/** 跑通 Builder、采集证据并写入一份全部通过的逐条判定。 */
async function verifiedBuild(db: ReturnType<typeof createTestDb>, goalId: string): Promise<void> {
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor((request) => {
      if (request.command === 'fake-agent') {
        writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
      }
      return {};
    }),
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });

  await collectEvidence(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });

  recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [...ACCEPTANCE, ...DOD].map((criterion) => ({
      criterion,
      result: 'passed' as const,
      note: '按验收标准复核通过',
    })),
  });
}

test('证据与逐条判定齐备时才判定完成', async () => {
  const { db, goalId } = singleItemPlan();
  await verifiedBuild(db, goalId);

  const assessment = assessCompletion(db, { goalId, actor: 'verifier-1' });

  assert.equal(assessment.workItems.length, 1);
  const [item] = assessment.workItems;
  assert.equal(item?.workItemId, 'build');
  assert.equal(item?.criteria, 4);
  assert.equal(item?.passed, 4);
  assert.equal(item?.complete, true);
  assert.deepEqual(item?.reasons, []);
  assert.ok(item?.verdictsRecordedAt);
  assert.ok(item?.evidenceCollectedAt);
  assert.equal(assessment.goal.complete, true);
  assert.deepEqual(assessment.goal.reasons, []);

  const event = listAuditEvents(db, goalId).find(
    (candidate) => candidate.type === 'verifier.completion_assessed',
  );
  assert.ok(event);
  assert.equal((event.payload as { goal: { complete: boolean } }).goal.complete, true);
});

test('有"不通过"或"无法判定"时不得完成，改判后以最新一次为准', async () => {
  const { db, goalId } = singleItemPlan();
  await verifiedBuild(db, goalId);

  recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [
      { criterion: ACCEPTANCE[0] as string, result: 'failed', note: '没有错误提示' },
      { criterion: ACCEPTANCE[1] as string, result: 'undetermined', note: '缺少枚举账号的检查' },
      { criterion: DOD[0] as string, result: 'passed', note: 'typecheck 通过' },
      { criterion: DOD[1] as string, result: 'passed', note: '有失败分支测试' },
    ],
  });

  const blocked = assessCompletion(db, { goalId });
  assert.equal(blocked.workItems[0]?.complete, false);
  assert.equal(blocked.workItems[0]?.failed, 1);
  assert.equal(blocked.workItems[0]?.undetermined, 1);
  assert.equal(blocked.goal.complete, false);
  assert.match(blocked.goal.reasons[0] ?? '', /未通过/);
  assert.match(blocked.goal.reasons[0] ?? '', /无法判定/);

  recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [...ACCEPTANCE, ...DOD].map((criterion) => ({
      criterion,
      result: 'passed' as const,
      note: '返工后复核通过',
    })),
  });

  const passed = assessCompletion(db, { goalId });
  assert.equal(passed.goal.complete, true);
});

test('任一工作项缺证据或缺判定时目标不得完成', async () => {
  const { db, goal } = setupApproved();
  await verifiedBuild(db, goal.id);

  const assessment = assessCompletion(db, { goalId: goal.id });
  assert.equal(assessment.workItems.length, 2);
  assert.equal(assessment.workItems[0]?.workItemId, 'build');
  assert.equal(assessment.workItems[0]?.complete, true);

  const verifyItem = assessment.workItems.find((item) => item.workItemId === 'verify');
  assert.ok(verifyItem);
  assert.equal(verifyItem.complete, false);
  assert.deepEqual(verifyItem.reasons, ['没有逐条判定', '没有可复用的证据']);
  assert.equal(assessment.goal.complete, false);
  assert.match(assessment.goal.reasons[0] ?? '', /工作项 verify 未完成/);
});