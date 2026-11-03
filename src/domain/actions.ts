/**
 * 动作集合与角色能力上限。
 *
 * 这里的 15 个动作是授权系统唯一的词汇表：Grant、升级、审计都只认这些值，
 * 不认自然语言描述，避免"看起来授权了"。
 */

export const ACTIONS = [
  'repo.read',
  'repo.write',
  'repo.commit',
  'repo.push',
  'pr.create',
  'pr.comment',
  'pr.review',
  'pr.merge',
  'ci.rerun',
  'release.deploy',
  'secret.read',
  'network.egress',
  'spend.tokens',
  'agent.spawn',
  'grant.issue',
] as const;

export type Action = (typeof ACTIONS)[number];

export type Role = 'architect' | 'planner' | 'builder' | 'verifier' | 'observer';

const ALL_ACTIONS: readonly Action[] = ACTIONS;

/** 角色能力上限：签发授权时先过这一层，再签具体动作。 */
export const ROLE_CAPS: Record<Role, readonly Action[]> = {
  architect: ALL_ACTIONS,
  planner: ['repo.read', 'pr.comment', 'spend.tokens', 'agent.spawn'],
  builder: ['repo.read', 'repo.write', 'repo.commit', 'repo.push', 'pr.create', 'pr.comment', 'ci.rerun', 'spend.tokens'],
  verifier: ['repo.read', 'pr.comment', 'pr.review', 'ci.rerun', 'spend.tokens'],
  observer: [],
};

/** 恒定需要第二人确认的动作（Q2 决策）；跨仓库写入由调用方额外标记。 */
export const SECOND_PERSON_ACTIONS: readonly Action[] = ['pr.merge', 'secret.read'];

export function requiresSecondPerson(action: Action, crossRepo = false): boolean {
  return SECOND_PERSON_ACTIONS.includes(action) || (action === 'repo.write' && crossRepo);
}
export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

export function isActionAllowedForRole(role: Role, action: Action): boolean {
  return ROLE_CAPS[role].includes(action);
}

/** 判断动作是否触碰仓库资源（用于必填空值校验）。 */
export function needsRepo(action: Action): boolean {
  return action.startsWith('repo.') || action.startsWith('pr.') || action === 'ci.rerun';
}

/** 简单的通配符匹配：只支持 `*`，用于分支与路径模式。 */
export function matchPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/** 判断父模式是否覆盖子模式（子模式只能更窄，不能更宽）。 */
export function patternCovers(parent: string, child: string): boolean {
  if (parent === child) return true;
  // 子模式里的 * 视为字面量，交给父模式去匹配；这保证子范围不会越出父范围。
  return matchPattern(parent, child);
}

/** 生成稳定的资源键，用于一次性审批的精确匹配。忽略空值，保证字段顺序无关。 */
export function resourceKey(resource: object): string {
  const entries = Object.entries(resource)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}