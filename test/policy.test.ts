import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  matchPattern,
  patternCovers,
  requiresSecondPerson,
  resourceKey,
} from '../src/domain/actions.ts';
import { assertAttenuated, authorize, autonomyAllows } from '../src/domain/policy.ts';
import type { Action, AuthorizationRequest, Grant } from '../src/domain/types.ts';

const REPO = 'acme/demo';
const GOAL = 'goal-1';
const SUBJECT = 'builder-1';

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'grant-1',
    goalId: GOAL,
    subject: SUBJECT,
    role: 'builder',
    actions: ['repo.read', 'repo.write', 'repo.commit', 'repo.push', 'pr.create'],
    scope: { repos: [REPO], branches: ['feature/sm-*'], paths: ['src/'] },
    constraints: {},
    issuerId: 'architect',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    goalId: GOAL,
    subject: SUBJECT,
    action: 'repo.read',
    resource: { repo: REPO },
    ...overrides,
  };
}

test('没有授权时默认拒绝，不生成升级', () => {
  const result = authorize(request(), []);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /没有覆盖该动作的授权/);
});

test('未知动作直接拒绝', () => {
  const result = authorize(request({ action: 'repo.fly' as Action }), [grant()]);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /未知动作/);
});

test('动作与资源都在范围内时放行', () => {
  const result = authorize(
    request({ action: 'repo.write', resource: { repo: REPO, branch: 'feature/sm-123', path: 'src/login.ts' } }),
    [grant()],
  );
  assert.equal(result.decision, 'allow');
  assert.equal(result.grantId, 'grant-1');
});

test('分支越界触发升级而不是直接拒绝', () => {
  const result = authorize(request({ action: 'repo.push', resource: { repo: REPO, branch: 'main' } }), [grant()]);
  assert.equal(result.decision, 'escalate');
  assert.match(result.reason, /超出范围/);
});

test('缺少分支信息视为越界', () => {
  const result = authorize(request({ action: 'repo.push', resource: { repo: REPO } }), [grant()]);
  assert.equal(result.decision, 'escalate');
});

test('路径越界触发升级', () => {
  const result = authorize(
    request({ action: 'repo.write', resource: { repo: REPO, branch: 'feature/sm-1', path: 'docs/readme.md' } }),
    [grant()],
  );
  assert.equal(result.decision, 'escalate');
});

test('缺少路径信息视为越界', () => {
  const result = authorize(
    request({ action: 'repo.write', resource: { repo: REPO, branch: 'feature/sm-1' } }),
    [grant()],
  );
  assert.equal(result.decision, 'escalate');
});

test('仓库不在授权范围内时升级', () => {
  const result = authorize(request({ resource: { repo: 'other/repo' } }), [grant()]);
  assert.equal(result.decision, 'escalate');
});

test('授权过期或已撤销后直接拒绝', () => {
  const expired = grant({ expiresAt: '2020-01-01T00:00:00.000Z' });
  const expiredResult = authorize(request(), [expired]);
  assert.equal(expiredResult.decision, 'deny');
  assert.match(expiredResult.reason, /授权已失效/);

  const revoked = grant({ status: 'revoked' });
  const revokedResult = authorize(request(), [revoked]);
  assert.equal(revokedResult.decision, 'deny');
  assert.match(revokedResult.reason, /授权已失效/);
});

test('密钥必须显式授权且精确匹配', () => {
  const noKeys = grant({ actions: ['secret.read'], scope: { repos: [REPO] } });
  assert.equal(
    authorize(request({ action: 'secret.read', resource: { repo: REPO, key: 'DEPLOY_KEY' } }), [noKeys]).decision,
    'escalate',
  );

  const withKey = grant({ actions: ['secret.read'], scope: { repos: [REPO], secretKeys: ['DEPLOY_KEY'] } });
  assert.equal(
    authorize(request({ action: 'secret.read', resource: { repo: REPO, key: 'DEPLOY_KEY' } }), [withKey]).decision,
    'allow',
  );
  assert.equal(
    authorize(request({ action: 'secret.read', resource: { repo: REPO, key: 'OTHER_KEY' } }), [withKey]).decision,
    'escalate',
  );
});

test('网络出口必须显式列出主机', () => {
  const noHosts = grant({ actions: ['network.egress'], scope: { repos: [REPO] } });
  assert.equal(
    authorize(request({ action: 'network.egress', resource: { host: 'api.github.com' } }), [noHosts]).decision,
    'escalate',
  );

  const withHost = grant({ actions: ['network.egress'], scope: { repos: [REPO], hosts: ['api.github.com'] } });
  assert.equal(
    authorize(request({ action: 'network.egress', resource: { host: 'api.github.com' } }), [withHost]).decision,
    'allow',
  );
  assert.equal(
    authorize(request({ action: 'network.egress', resource: { host: 'evil.example.com' } }), [withHost]).decision,
    'escalate',
  );
});

test('token 额度不得超过约束上限', () => {
  const limited = grant({ actions: ['spend.tokens'], scope: { repos: [REPO] }, constraints: { maxTokens: 100 } });
  assert.equal(
    authorize(request({ action: 'spend.tokens', resource: { tokens: 50 } }), [limited]).decision,
    'allow',
  );
  assert.equal(
    authorize(request({ action: 'spend.tokens', resource: { tokens: 101 } }), [limited]).decision,
    'escalate',
  );
});

test('通配符只支持 *，且父模式必须覆盖子模式', () => {
  assert.equal(matchPattern('feature/sm-*', 'feature/sm-12'), true);
  assert.equal(matchPattern('feature/sm-*', 'feature/other'), false);
  assert.equal(patternCovers('feature/*', 'feature/sm-1'), true);
  assert.equal(patternCovers('feature/sm-*', 'feature/*'), false);
});

test('资源键忽略字段顺序与空值', () => {
  assert.equal(
    resourceKey({ repo: REPO, branch: 'main' }),
    resourceKey({ branch: 'main', repo: REPO, path: undefined }),
  );
});

test('子授权不能新增动作', () => {
  const parent = grant();
  assert.throws(
    () => assertAttenuated(parent, { actions: ['repo.read', 'pr.merge'], scope: { repos: [REPO] } }),
    /没有的动作/,
  );
});

test('子授权不能扩大仓库、分支、路径与额度', () => {
  const parent = grant({ constraints: { maxTokens: 1000 } });
  assert.throws(() => assertAttenuated(parent, { actions: ['repo.read'], scope: { repos: ['other/repo'] } }), /仓库范围/);
  assert.throws(
    () => assertAttenuated(parent, { actions: ['repo.read'], scope: { repos: [REPO], branches: ['main'], paths: ['src/'] } }),
    /分支范围/,
  );
  assert.throws(
    () =>
      assertAttenuated(parent, {
        actions: ['repo.read'],
        scope: { repos: [REPO], branches: ['feature/sm-1'], paths: ['docs/'] },
      }),
    /路径范围/,
  );
  assert.throws(
    () =>
      assertAttenuated(parent, {
        actions: ['repo.read'],
        scope: { repos: [REPO], branches: ['feature/sm-1'], paths: ['src/'] },
        constraints: { maxTokens: 2000 },
      }),
    /额度超过父授权/,
  );
});

test('父授权限定分支时子授权必须显式限定', () => {
  const parent = grant();
  assert.throws(
    () => assertAttenuated(parent, { actions: ['repo.read'], scope: { repos: [REPO], paths: ['src/'] } }),
    /必须显式限定/,
  );
});

test('合法收窄的子授权通过衰减校验', () => {
  const parent = grant();
  assert.doesNotThrow(() =>
    assertAttenuated(parent, {
      actions: ['repo.write', 'repo.push'],
      scope: { repos: [REPO], branches: ['feature/sm-1'], paths: ['src/login'] },
    }),
  );
});

test('自治级别是硬上限，不是授权本身', () => {
  assert.equal(autonomyAllows('A2', 'pr.merge'), false);
  assert.equal(autonomyAllows('A3', 'pr.merge'), true);
  assert.equal(autonomyAllows('A2', 'release.deploy'), false);
  assert.equal(autonomyAllows('A4', 'release.deploy'), true);
  assert.equal(autonomyAllows('A1', 'repo.write'), false);
  assert.equal(autonomyAllows('A2', 'repo.write'), true);
  assert.equal(autonomyAllows('A1', 'repo.read'), true);
});

test('第二人规则覆盖合并、密钥与跨仓库写入', () => {
  assert.equal(requiresSecondPerson('pr.merge'), true);
  assert.equal(requiresSecondPerson('secret.read'), true);
  assert.equal(requiresSecondPerson('repo.write', true), true);
  assert.equal(requiresSecondPerson('repo.write', false), false);
  assert.equal(requiresSecondPerson('repo.read'), false);
});