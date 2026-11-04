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
  let version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

  if (version < 1) {
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
    version = 1;
  }

  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        repo_dir TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        removed_at TEXT
      );

      -- 同一工作项只允许一个活跃 worktree，避免并发写同一分支。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_active
        ON workspaces(goal_id, work_item_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_workspaces_goal ON workspaces(goal_id);
    `);

    db.exec('PRAGMA user_version = 2;');
    version = 2;
  }

  if (version < 3) {
    db.exec(`
      ALTER TABLE goals ADD COLUMN paused_from TEXT;

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT,
        audit_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_item
        ON checkpoints(goal_id, work_item_id, created_at);
    `);

    db.exec('PRAGMA user_version = 3;');
    version = 3;
  }

  if (version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        work_item_id TEXT,
        run_id TEXT,
        source TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_goal ON token_usage(goal_id, created_at);
    `);

    db.exec('PRAGMA user_version = 4;');
    version = 4;
  }

  if (version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playbook_golden_tasks (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        criteria TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_golden_tasks_role
        ON playbook_golden_tasks(role);

      CREATE TABLE IF NOT EXISTS playbook_proposals (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        base_version_id TEXT,
        base_version INTEGER,
        content TEXT NOT NULL,
        rationale TEXT NOT NULL,
        source_goal_id TEXT,
        created_by TEXT NOT NULL,
        status TEXT NOT NULL,
        evaluation TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_playbook_proposals_role
        ON playbook_proposals(role, created_at);

      CREATE TABLE IF NOT EXISTS playbook_versions (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        canary_percent INTEGER NOT NULL,
        source_proposal_id TEXT,
        metrics TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        retired_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_versions_role_version
        ON playbook_versions(role, version);
      CREATE INDEX IF NOT EXISTS idx_playbook_versions_role_status
        ON playbook_versions(role, status);
    `);

    db.exec('PRAGMA user_version = 5;');
  }
}