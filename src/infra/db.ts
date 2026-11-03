import { DatabaseSync } from 'node:sqlite';

/**
 * 唯一的数据库入口。
 *
 * 单进程 + 同步驱动 + 单写队列：P0 阶段不做并发写优化，
 * 先把一致性和可追溯性做对。
 */
export function openDatabase(path = './manner.db'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version >= 1) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      repo TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      constraints TEXT NOT NULL,
      budget_tokens INTEGER NOT NULL,
      autonomy TEXT NOT NULL,
      status TEXT NOT NULL,
      missing TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      work_items TEXT NOT NULL,
      total_budget_tokens INTEGER NOT NULL,
      risks TEXT NOT NULL,
      pending_decisions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      rejection_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      work_item_id TEXT,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      actions TEXT NOT NULL,
      scope TEXT NOT NULL,
      constraints TEXT NOT NULL,
      parent_grant_id TEXT,
      issuer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      revoke_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      reason TEXT NOT NULL,
      impact TEXT NOT NULL,
      options TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      status TEXT NOT NULL,
      requires_second INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      decision_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      escalation_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      goal_id TEXT,
      subject TEXT,
      payload TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_plans_goal ON plans(goal_id);
    CREATE INDEX IF NOT EXISTS idx_grants_goal ON grants(goal_id);
    CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
    CREATE INDEX IF NOT EXISTS idx_audit_goal ON audit(goal_id, at);
  `);

  db.exec('PRAGMA user_version = 1;');
}