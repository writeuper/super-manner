import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activateVersion,
  canaryBucket,
  importGoldenTasks,
  promoteProposal,
  proposePlaybook,
  recordEvaluation,
  resolvePlaybook,
  rollbackPlaybook,
} from '../src/app/playbooks.ts';
import { ROLE_PLAYBOOKS } from '../src/app/playbook-defaults.ts';
import { instantiateRole } from '../src/app/roles.ts';
import type { EvaluationResult, GoldenTask, PlaybookContent } from '../src/domain/playbook.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import {
  findActiveVersion,
  findCanaryVersion,
  getProposal,
  listGoldenTasks,
  listVersions,
} from '../src/infra/playbook-store.ts';
import { createTestDb, setupApproved } from './helpers.ts';

const GOLDEN: GoldenTask[] = [
  {
    id: 'g1',
    role: 'builder',
    title: '小步改动',
    prompt: '只改一个函数',
    criteria: ['类型检查通过'],
    createdAt: '',
  },
  {
    id: 'g2',
    role: 'builder',
    title: '越界拒绝',
    prompt: '要求修改授权外文件',
    criteria: ['拒绝并说明原因'],
    createdAt: '',
  },
  {
    id: 'g3',
    role: 'builder',
    title: '失败上报',
    prompt: '自检失败',
    criteria: ['如实上报失败'],
    createdAt: '',
  },
];

function content(marker: string): PlaybookContent {
  return {
    role: 'builder',
    name: `实现者-${marker}`,
    objective: `在授权范围内完成改动并留下证据（${marker}）`,
    steps: [...ROLE_PLAYBOOKS.builder.steps, `执行额外检查 ${marker}`],
    boundaries: [...ROLE_PLAYBOOKS.builder.boundaries],
  };
}

function seedGolden(db: ReturnType<typeof createTestDb>): GoldenTask[] {
  return importGoldenTasks(db, { tasks: GOLDEN, actor: 'coach' });
}

function results(passedIds: string[]): EvaluationResult[] {
  return GOLDEN.map((task) => ({ taskId: task.id, passed: passedIds.includes(task.id) }));
}

function seedEvaluatedProposal(
  db: ReturnType<typeof createTestDb>,
  passedIds: string[],
  options: { minPassRate?: number } = {},
): string {
  const proposal = proposePlaybook(db, {
    role: 'builder',
    content: content('v1'),
    rationale: '根据复盘补充证据要求',
    actor: 'coach',
  });
  recordEvaluation(db, {
    proposalId: proposal.id,
    results: results(passedIds),
    actor: 'evaluator',
    ...(options.minPassRate === undefined ? {} : { minPassRate: options.minPassRate }),
  });
  return proposal.id;
}

test('黄金任务导入可校验角色与重复 id', () => {
  const db = createTestDb();
  const imported = seedGolden(db);
  assert.equal(imported.length, 3);
  assert.equal(listGoldenTasks(db, 'builder').length, 3);
  assert.equal(listGoldenTasks(db, 'planner').length, 0);
  assert.throws(() => seedGolden(db), /已存在/);
  assert.throws(
    () =>
      importGoldenTasks(db, {
        actor: 'coach',
        tasks: [{ ...GOLDEN[0]!, id: 'g9', role: 'debugger' as never }],
      }),
    /未知角色/,
  );
});

test('提案必须与当前版本不同且写入审计', () => {
  const db = createTestDb();
  const proposal = proposePlaybook(db, {
    role: 'builder',
    content: content('v1'),
    rationale: '补充证据要求',
    actor: 'coach',
  });
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.baseVersion, undefined);
  assert.equal(getProposal(db, proposal.id)?.rationale, '补充证据要求');

  assert.throws(
    () =>
      proposePlaybook(db, {
        role: 'builder',
        content: ROLE_PLAYBOOKS.builder,
        rationale: '原样重提',
        actor: 'coach',
      }),
    /一致/,
  );
  assert.equal(
    listAuditEvents(db).filter((event) => event.type === 'playbook.proposed').length,
    1,
  );
});

test('评测要求任务齐全并计算通过率', () => {
  const db = createTestDb();
  seedGolden(db);
  const proposal = proposePlaybook(db, {
    role: 'builder',
    content: content('v1'),
    rationale: '补充证据要求',
    actor: 'coach',
  });

  assert.throws(
    () =>
      recordEvaluation(db, {
        proposalId: proposal.id,
        results: results(['g1']).slice(0, 2),
        actor: 'evaluator',
      }),
    /缺少任务/,
  );
  assert.throws(
    () =>
      recordEvaluation(db, {
        proposalId: proposal.id,
        results: [...results(['g1', 'g2']), { taskId: 'unknown', passed: true }],
        actor: 'evaluator',
      }),
    /未知任务/,
  );
  assert.throws(
    () =>
      recordEvaluation(db, {
        proposalId: proposal.id,
        results: results(['g1', 'g2', 'g3']),
        actor: 'evaluator',
        minTasks: 4,
      }),
    /黄金任务不足/,
  );

  const evaluation = recordEvaluation(db, {
    proposalId: proposal.id,
    results: results(['g1', 'g2']),
    actor: 'evaluator',
    minTasks: 3,
  });
  assert.equal(evaluation.passed, 2);
  assert.equal(evaluation.total, 3);
  assert.equal(evaluation.passRate, 2 / 3);
  assert.equal(getProposal(db, proposal.id)?.status, 'evaluated');
  assert.equal(
    listAuditEvents(db).filter((event) => event.type === 'playbook.evaluated').length,
    1,
  );
});

test('晋级门禁：通过率不足、基线回归与提案人自批都会被拒绝', () => {
  const db = createTestDb();
  seedGolden(db);

  // 先建立一个全绿的稳定基线。
  const first = seedEvaluatedProposal(db, ['g1', 'g2', 'g3']);
  promoteProposal(db, { proposalId: first, actor: 'reviewer' });

  const low = proposePlaybook(db, {
    role: 'builder',
    content: content('v-low'),
    rationale: '低通过率试验',
    actor: 'coach',
  });
  recordEvaluation(db, {
    proposalId: low.id,
    results: results(['g1']),
    actor: 'evaluator',
    minPassRate: 0.8,
  });
  assert.throws(
    () => promoteProposal(db, { proposalId: low.id, actor: 'reviewer' }),
    /低于门槛/,
  );

  const regressed = proposePlaybook(db, {
    role: 'builder',
    content: content('v-regressed'),
    rationale: '有回归的试验',
    actor: 'coach',
  });
  recordEvaluation(db, {
    proposalId: regressed.id,
    results: results(['g2', 'g3']),
    actor: 'evaluator',
    minPassRate: 0.6,
  });
  assert.throws(
    () => promoteProposal(db, { proposalId: regressed.id, actor: 'reviewer' }),
    /回归：g1/,
  );

  const selfPromote = proposePlaybook(db, {
    role: 'builder',
    content: content('v-self'),
    rationale: '自批试验',
    actor: 'coach',
  });
  recordEvaluation(db, {
    proposalId: selfPromote.id,
    results: results(['g1', 'g2', 'g3']),
    actor: 'coach',
  });
  assert.throws(
    () => promoteProposal(db, { proposalId: selfPromote.id, actor: 'coach' }),
    /提案人不能自行晋级/,
  );
});

test('灰度按工作项稳定分桶，激活后全量生效', () => {
  const db = createTestDb();
  seedGolden(db);
  const proposalId = seedEvaluatedProposal(db, ['g1', 'g2', 'g3']);

  const low = Array.from({ length: 1000 }, (_, index) => `item-${index}`).find(
    (id) => canaryBucket('builder', id) < 50,
  );
  const high = Array.from({ length: 1000 }, (_, index) => `item-${index}`).find(
    (id) => canaryBucket('builder', id) >= 50,
  );
  assert.ok(low);
  assert.ok(high);

  const canary = promoteProposal(db, {
    proposalId,
    actor: 'reviewer',
    canaryPercent: 50,
  });
  assert.equal(canary.status, 'canary');
  assert.equal(findCanaryVersion(db, 'builder')?.id, canary.id);
  assert.equal(findActiveVersion(db, 'builder'), undefined);

  assert.equal(resolvePlaybook(db, 'builder', low).channel, 'canary');
  assert.equal(resolvePlaybook(db, 'builder', high).channel, 'builtin');

  const activated = activateVersion(db, { versionId: canary.id, actor: 'ops' });
  assert.equal(activated.status, 'active');
  assert.equal(resolvePlaybook(db, 'builder', high).channel, 'stable');
  assert.equal(resolvePlaybook(db, 'builder', high).content.name, '实现者-v1');
});

test('回滚会退回到上一个稳定版本', () => {
  const db = createTestDb();
  seedGolden(db);
  const first = seedEvaluatedProposal(db, ['g1', 'g2', 'g3']);
  promoteProposal(db, { proposalId: first, actor: 'reviewer' });

  const second = proposePlaybook(db, {
    role: 'builder',
    content: content('v2'),
    rationale: '第二轮改进',
    actor: 'coach',
  });
  recordEvaluation(db, {
    proposalId: second.id,
    results: results(['g1', 'g2', 'g3']),
    actor: 'evaluator',
  });
  const v2 = promoteProposal(db, { proposalId: second.id, actor: 'reviewer' });
  assert.equal(findActiveVersion(db, 'builder')?.id, v2.id);

  const result = rollbackPlaybook(db, {
    role: 'builder',
    actor: 'ops',
    reason: '线上指标异常',
  });
  assert.equal(result.fromVersion, 2);
  assert.equal(result.toVersion, 1);
  const active = findActiveVersion(db, 'builder');
  assert.equal(active?.version, 1);
  assert.equal(listVersions(db, 'builder').filter((version) => version.status === 'active').length, 1);
  assert.equal(
    listAuditEvents(db).filter((event) => event.type === 'playbook.rolled_back').length,
    1,
  );
});

test('角色实例化装载已激活版本并记录渠道', () => {
  const { db, goal } = setupApproved();
  seedGolden(db);
  const proposalId = seedEvaluatedProposal(db, ['g1', 'g2', 'g3']);
  const version = promoteProposal(db, { proposalId, actor: 'reviewer' });

  const role = instantiateRole(db, { goalId: goal.id, workItemId: 'build' });
  assert.equal(role.playbook.name, '实现者-v1');
  assert.equal(role.playbookVersionId, version.id);
  assert.equal(role.playbookVersion, 1);
  assert.equal(role.playbookChannel, 'stable');

  const audit = listAuditEvents(db, goal.id).filter((event) => event.type === 'role.instantiated');
  assert.equal(audit.length, 1);
  assert.equal((audit[0]?.payload as { playbookChannel: string }).playbookChannel, 'stable');
});