import type { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '../domain/types.ts';
import { listAuditEvents } from '../infra/audit.ts';
import { getGoal, listEscalations, listGoals, listPlansForGoal } from '../infra/store.ts';

function payloadOf(event: AuditEvent): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

/** 审计事件里表达"动作"的字段，兼容授权请求与升级。 */
function payloadAction(event: AuditEvent): string | undefined {
  const payload = payloadOf(event);
  const request = payload.request as { action?: unknown } | undefined;
  if (typeof request?.action === 'string') return request.action;
  return typeof payload.action === 'string' ? payload.action : undefined;
}

export interface TimelineQuery {
  goalId?: string;
  actor?: string;
  subject?: string;
  /** 匹配事件类型，或事件载荷中的动作（如 repo.write / pr.merge）。 */
  action?: string;
  /** 只保留最近 N 条，结果仍按时间升序。 */
  limit?: number;
}

/** 按目标、人、动作筛选审计时间线，只读。 */
export function queryTimeline(db: DatabaseSync, query: TimelineQuery = {}): AuditEvent[] {
  let events = listAuditEvents(db, query.goalId);
  if (query.actor) events = events.filter((event) => event.actor === query.actor);
  if (query.subject) events = events.filter((event) => event.subject === query.subject);
  if (query.action) {
    events = events.filter(
      (event) => event.type === query.action || payloadAction(event) === query.action,
    );
  }
  if (query.limit !== undefined) events = events.slice(-Math.max(query.limit, 0));
  return events;
}

export type InboxKind = 'plan_review' | 'escalation' | 'acceptance';

export interface InboxItem {
  kind: InboxKind;
  goalId: string;
  goalTitle: string;
  title: string;
  createdAt: string;
  /** 升级对应的动作，其余待办为空。 */
  action?: string;
  reason?: string;
  dueAt?: string;
  requiresSecond?: boolean;
}

export interface InboxQuery {
  goalId?: string;
  /** 待办类型，或升级动作。 */
  action?: string;
}

/**
 * "待我处理"队列：待审计划、待裁决升级、待验收目标。
 *
 * 只做聚合，不改变任何状态；过期升级不进入队列，等待 sweep 处理。
 */
export function listInbox(db: DatabaseSync, query: InboxQuery = {}, now = new Date()): InboxItem[] {
  const goals = listGoals(db).filter((goal) => !query.goalId || goal.id === query.goalId);
  const goalIds = new Set(goals.map((goal) => goal.id));
  const items: InboxItem[] = [];

  for (const goal of goals) {
    for (const plan of listPlansForGoal(db, goal.id)) {
      if (plan.status !== 'submitted') continue;
      items.push({
        kind: 'plan_review',
        goalId: goal.id,
        goalTitle: goal.title,
        title: `计划 v${plan.version} 待审批`,
        createdAt: plan.createdAt,
      });
    }
    if (goal.status === 'awaiting_acceptance') {
      items.push({
        kind: 'acceptance',
        goalId: goal.id,
        goalTitle: goal.title,
        title: '目标待验收',
        createdAt: goal.updatedAt,
      });
    }
  }

  for (const escalation of listEscalations(db, 'pending')) {
    if (!goalIds.has(escalation.goalId)) continue;
    if (new Date(escalation.expiresAt).getTime() <= now.getTime()) continue;
    const goal = goals.find((item) => item.id === escalation.goalId) ?? getGoal(db, escalation.goalId);
    items.push({
      kind: 'escalation',
      goalId: escalation.goalId,
      goalTitle: goal?.title ?? escalation.goalId,
      title: `升级待裁决：${escalation.action}`,
      createdAt: escalation.createdAt,
      action: escalation.action,
      reason: escalation.reason,
      dueAt: escalation.expiresAt,
      requiresSecond: escalation.requiresSecond,
    });
  }

  const filtered = query.action
    ? items.filter((item) =>
        item.kind === 'escalation' ? item.action === query.action : item.kind === query.action,
      )
    : items;

  return filtered.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}