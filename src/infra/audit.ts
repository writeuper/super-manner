import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '../domain/types.ts';

type Row = Record<string, unknown>;

export interface AuditInput {
  actor: string;
  type: string;
  goalId?: string;
  subject?: string;
  payload?: unknown;
}

function computeHash(input: {
  prevHash: string;
  at: string;
  actor: string;
  type: string;
  payload: unknown;
}): string {
  return createHash('sha256')
    .update(`${input.prevHash}\n${input.at}\n${input.actor}\n${input.type}\n${JSON.stringify(input.payload ?? null)}`)
    .digest('hex');
}

function lastHash(db: DatabaseSync): string {
  const row = db.prepare('SELECT hash FROM audit ORDER BY rowid DESC LIMIT 1').get() as Row | undefined;
  return row ? String(row.hash) : '';
}

/**
 * 只追加的审计链。
 *
 * 每条记录包含前一条的哈希，任何删改都会让 verifyAuditChain 失败。
 * 服务层不得提供更新/删除审计的接口。
 */
export function appendAudit(db: DatabaseSync, input: AuditInput, at = new Date().toISOString()): AuditEvent {
  const prevHash = lastHash(db);
  const payload = input.payload ?? null;
  const hash = computeHash({ prevHash, at, actor: input.actor, type: input.type, payload });
  const event: AuditEvent = {
    id: randomUUID(),
    at,
    actor: input.actor,
    type: input.type,
    payload,
    prevHash,
    hash,
  };
  if (input.goalId) event.goalId = input.goalId;
  if (input.subject) event.subject = input.subject;

  db.prepare(
    `INSERT INTO audit (id, at, actor, type, goal_id, subject, payload, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.at,
    event.actor,
    event.type,
    event.goalId ?? null,
    event.subject ?? null,
    JSON.stringify(event.payload),
    event.prevHash,
    event.hash,
  );

  return event;
}

function eventFromRow(row: Row): AuditEvent {
  return {
    id: String(row.id),
    at: String(row.at),
    actor: String(row.actor),
    type: String(row.type),
    goalId: row.goal_id === null ? undefined : String(row.goal_id),
    subject: row.subject === null ? undefined : String(row.subject),
    payload: JSON.parse(String(row.payload)),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

export function listAuditEvents(db: DatabaseSync, goalId?: string): AuditEvent[] {
  const rows = goalId
    ? (db.prepare('SELECT * FROM audit WHERE goal_id = ? ORDER BY rowid ASC').all(goalId) as Row[])
    : (db.prepare('SELECT * FROM audit ORDER BY rowid ASC').all() as Row[]);
  return rows.map(eventFromRow);
}

export function verifyAuditChain(db: DatabaseSync): { ok: boolean; checked: number; brokenAt?: string } {
  const events = listAuditEvents(db);
  let prevHash = '';
  for (const event of events) {
    if (event.prevHash !== prevHash) return { ok: false, checked: events.length, brokenAt: event.id };
    const expected = computeHash({
      prevHash: event.prevHash,
      at: event.at,
      actor: event.actor,
      type: event.type,
      payload: event.payload,
    });
    if (expected !== event.hash) return { ok: false, checked: events.length, brokenAt: event.id };
    prevHash = event.hash;
  }
  return { ok: true, checked: events.length };
}