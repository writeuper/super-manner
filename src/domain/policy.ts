import {
  isAction,
  matchPattern,
  needsRepo,
  patternCovers,
} from './actions.ts';
import type {
  Action,
  AuthorizationRequest,
  AuthResult,
  AutonomyLevel,
  Grant,
  GrantConstraints,
  GrantScope,
  GrantSpec,
  ResourceRef,
} from './types.ts';

const AUTONOMY_RANK: Record<AutonomyLevel, number> = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 };

/**
 * 自治级别是上限，不是授权本身：
 * 即使 Grant 写了 pr.merge，A2 目标也不能签发它。
 */
export function autonomyAllows(level: AutonomyLevel, action: Action): boolean {
  const rank = AUTONOMY_RANK[level];
  switch (action) {
    case 'release.deploy':
      return rank >= 4;
    case 'pr.merge':
      return rank >= 3;
    case 'repo.write':
    case 'repo.commit':
    case 'repo.push':
    case 'pr.create':
      return rank >= 2;
    case 'pr.comment':
    case 'repo.read':
    case 'pr.review':
    case 'ci.rerun':
    case 'secret.read':
    case 'network.egress':
    case 'spend.tokens':
    case 'agent.spawn':
    case 'grant.issue':
      return rank >= 1;
    default:
      return false;
  }
}

function grantUsable(grant: Grant, now: Date): boolean {
  if (grant.status !== 'active') return false;
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

function pathCovered(prefixes: string[] | undefined, path: string | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  if (!path) return false;
  const normalized = path.replace(/^\.\//, '');
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix.replace(/\/$/, '')}/`));
}

function scopeAllows(grant: Grant, resource: ResourceRef, action: Action): boolean {
  const scope: GrantScope = grant.scope;

  if (needsRepo(action)) {
    if (!resource.repo) return false;
    if (!scope.repos.includes(resource.repo)) return false;
  }

  if (action === 'repo.write' || action === 'repo.commit' || action === 'repo.push') {
    if (scope.branches && scope.branches.length > 0) {
      if (!resource.branch) return false;
      if (!scope.branches.some((pattern) => matchPattern(pattern, resource.branch as string))) return false;
    }
    if ((action === 'repo.write' || action === 'repo.commit') && !pathCovered(scope.paths, resource.path)) {
      return false;
    }
  }

  if (action === 'secret.read') {
    if (!scope.secretKeys || scope.secretKeys.length === 0) return false;
    if (!resource.key || !scope.secretKeys.includes(resource.key)) return false;
  }

  if (action === 'network.egress') {
    if (!scope.hosts || scope.hosts.length === 0) return false;
    if (!resource.host || !scope.hosts.includes(resource.host)) return false;
  }

  if (action === 'spend.tokens' && grant.constraints.maxTokens !== undefined) {
    const tokens = resource.tokens ?? 0;
    if (tokens > grant.constraints.maxTokens) return false;
  }

  return true;
}

/**
 * 授权判定的唯一入口。
 *
 * 三种结果的含义必须严格区分：
 * - deny：根本没有这个动作的授权，或授权已失效。不生成升级卡片。
 * - escalate：动作有授权，但资源/额度越界。生成升级卡片，等人裁决。
 * - allow：在授权范围内。
 */
export function authorize(request: AuthorizationRequest, grants: Grant[], now = new Date()): AuthResult {
  if (!isAction(request.action)) {
    return { decision: 'deny', reason: '未知动作' };
  }

  const relevant = grants.filter(
    (grant) =>
      grant.goalId === request.goalId &&
      grant.subject === request.subject &&
      grant.actions.includes(request.action),
  );

  const usable = relevant.filter((grant) => grantUsable(grant, now));

  if (usable.length === 0) {
    if (relevant.length > 0) {
      return { decision: 'deny', reason: '授权已失效（已撤销或过期）' };
    }
    return { decision: 'deny', reason: '没有覆盖该动作的授权' };
  }

  for (const grant of usable) {
    if (scopeAllows(grant, request.resource, request.action)) {
      return { decision: 'allow', reason: '在授权范围内', grantId: grant.id };
    }
  }

  return { decision: 'escalate', reason: '动作已授权，但资源或额度超出范围' };
}

/** 子授权只能更窄：动作、仓库、分支、路径、额度都不允许放大。 */
export function assertAttenuated(parent: GrantSpec, child: GrantSpec): void {
  const extraActions = child.actions.filter((action) => !parent.actions.includes(action));
  if (extraActions.length > 0) {
    throw new Error(`子授权包含父授权没有的动作：${extraActions.join(', ')}`);
  }

  const extraRepos = child.scope.repos.filter((repo) => !parent.scope.repos.includes(repo));
  if (extraRepos.length > 0) {
    throw new Error(`子授权扩大了仓库范围：${extraRepos.join(', ')}`);
  }

  if (parent.scope.branches) {
    if (!child.scope.branches) throw new Error('父授权限定了分支，子授权必须显式限定');
    const wider = child.scope.branches.filter(
      (branch) => !parent.scope.branches?.some((pattern) => patternCovers(pattern, branch)),
    );
    if (wider.length > 0) throw new Error(`子授权扩大了分支范围：${wider.join(', ')}`);
  }

  if (parent.scope.paths) {
    if (!child.scope.paths) throw new Error('父授权限定了路径，子授权必须显式限定');
    const wider = child.scope.paths.filter(
      (path) => !parent.scope.paths?.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`)),
    );
    if (wider.length > 0) throw new Error(`子授权扩大了路径范围：${wider.join(', ')}`);
  }

  if (parent.scope.hosts) {
    const wider = (child.scope.hosts ?? []).filter((host) => !parent.scope.hosts?.includes(host));
    if (wider.length > 0) throw new Error(`子授权扩大了网络范围：${wider.join(', ')}`);
  }

  if (parent.scope.secretKeys) {
    const wider = (child.scope.secretKeys ?? []).filter((key) => !parent.scope.secretKeys?.includes(key));
    if (wider.length > 0) throw new Error(`子授权扩大了密钥范围：${wider.join(', ')}`);
  }

  const parentLimits: GrantConstraints = parent.constraints ?? {};
  const childLimits: GrantConstraints = child.constraints ?? {};

  if (parentLimits.expiresAt && childLimits.expiresAt && new Date(childLimits.expiresAt) > new Date(parentLimits.expiresAt)) {
    throw new Error('子授权有效期超过父授权');
  }
  if (parentLimits.maxTokens !== undefined && childLimits.maxTokens !== undefined && childLimits.maxTokens > parentLimits.maxTokens) {
    throw new Error('子授权 token 额度超过父授权');
  }
  if (
    parentLimits.maxMergeCount !== undefined &&
    childLimits.maxMergeCount !== undefined &&
    childLimits.maxMergeCount > parentLimits.maxMergeCount
  ) {
    throw new Error('子授权合并次数超过父授权');
  }
}