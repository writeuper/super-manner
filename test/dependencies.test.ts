import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBuilder } from '../src/app/builder.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { submitPlan } from '../src/app/plans.ts';
import { instantiateRole } from '../src/app/roles.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import { startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import {
  builderItem,
  commitAndPush,
  createTestDb,
  createTestGoal,
  createTestRepo,
  defaultGoal,
  setupApproved,
} from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

class FakeExecutor implements Executor {
  readonly name = 'fake';

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
    }
    return {
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
    };
  }
}

test('计划提交时拒绝循环依赖', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);

  assert.throws(
    () =>
      submitPlan(
        db,
        goal.id,
        {
          workItems: [
            builderItem({ id: 'a', dependsOn: ['b'] }),
            builderItem({ id: 'b', dependsOn: ['a'] }),
          ],
          totalBudgetTokens: 2000,
          pendingDecisions: [],
        },
        'planner',
      ),
    /依赖存在循环/,
  );
});

test('前置工作项完成后才允许装载下游角色', async () => {
  const { db, goal } = setupApproved();

  assert.throws(
    () => instantiateRole(db, { goalId: goal.id, workItemId: 'verify' }),
    /依赖 build 尚未完成/,
  );

  const repo = createTestRepo({ bareRemote: true });
  tempRoots.push(repo.root);
  await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
  commitAndPush(db, goal.id);
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });
  await collectEvidence(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
  recordVerdicts(db, {
    goalId: goal.id,
    workItemId: 'build',
    verdicts: [...defaultGoal().acceptance, ...builderItem().dod].map((criterion) => ({
      criterion,
      result: 'passed' as const,
      note: '依赖工作项已验收',
    })),
  });

  const instance = instantiateRole(db, { goalId: goal.id, workItemId: 'verify' });
  assert.equal(instance.role, 'verifier');
  assert.equal(instance.subject, 'verifier-1');
});