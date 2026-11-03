#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { cancelGoal, createGoal, getGoalOrThrow } from './app/goals.ts';
import { approvePlan, rejectPlan, submitPlan, type SubmitPlanInput } from './app/plans.ts';
import { decideEscalation, sweepExpiredEscalations } from './app/escalations.ts';
import { requestAction } from './app/gateway.ts';
import { isAction } from './domain/actions.ts';
import type { AutonomyLevel, ResourceRef } from './domain/types.ts';
import { listAuditEvents, verifyAuditChain } from './infra/audit.ts';
import { openDatabase } from './infra/db.ts';
import { getGoal, listEscalations, listGrantsForGoal, listPlansForGoal } from './infra/store.ts';

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      const existing = flags.get(name);
      if (existing === undefined) flags.set(name, next);
      else if (Array.isArray(existing)) existing.push(next);
      else if (typeof existing === 'string') flags.set(name, [existing, next]);
      else flags.set(name, [next]);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function one(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  return typeof value === 'string' ? value : undefined;
}

function many(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function bool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function required(args: ParsedArgs, name: string): string {
  const value = one(args, name);
  if (!value) throw new Error(`缺少参数 --${name}`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printGoal(db: DatabaseSync, goalId: string): void {
  const goal = getGoalOrThrow(db, goalId);
  print({
    goal,
    plans: listPlansForGoal(db, goalId).map((plan) => ({ id: plan.id, version: plan.version, status: plan.status })),
    grants: listGrantsForGoal(db, goalId).map((grant) => ({
      id: grant.id,
      subject: grant.subject,
      actions: grant.actions,
      status: grant.status,
    })),
  });
}

const USAGE = `Super-Manner CLI

用法：
  manner init [--db <path>]
  manner goal new --title <t> --repo <owner/repo> [--base main] [--acceptance <a> ...]
                  [--budget 100000] [--autonomy A2] [--by <id>]
  manner goal show <goalId>
  manner goal cancel <goalId> --by <id>
  manner plan submit <goalId> --file plan.json --by <id>
  manner plan approve <planId> --by <id>
  manner plan reject <planId> --by <id> --reason <text>
  manner grant list --goal <goalId>
  manner escalation list [--pending]
  manner escalation decide <id> --by <id> --approve|--deny [--second <id>] [--reason <text>]
  manner escalation sweep
  manner auth request --goal <id> --subject <id> --action <action> [--repo r] [--branch b] [--path p] [--key k] [--host h]
  manner audit log [--goal <id>]
  manner audit verify
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand, third] = args.positional;
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }

  const db = openDatabase(one(args, 'db') ?? process.env.MANNER_DB ?? './manner.db');

  try {
    switch (command) {
      case 'init':
        print({ ok: true, database: one(args, 'db') ?? process.env.MANNER_DB ?? './manner.db' });
        return;

      case 'goal': {
        if (subcommand === 'new') {
          const goal = createGoal(
            db,
            {
              title: one(args, 'title') ?? '',
              description: one(args, 'description') ?? '',
              repo: one(args, 'repo') ?? '',
              baseBranch: one(args, 'base') ?? 'main',
              acceptance: many(args, 'acceptance'),
              constraints: many(args, 'constraint'),
              budgetTokens: Number(one(args, 'budget') ?? 0),
              autonomy: (one(args, 'autonomy') ?? 'A2') as AutonomyLevel,
            },
            one(args, 'by') ?? 'architect',
          );
          print(goal);
          return;
        }
        if (subcommand === 'show' && third) {
          printGoal(db, third);
          return;
        }
        if (subcommand === 'cancel' && third) {
          print(cancelGoal(db, third, required(args, 'by')));
          return;
        }
        break;
      }

      case 'plan': {
        if (subcommand === 'submit') {
          const goalId = third;
          if (!goalId) throw new Error('缺少目标 id');
          const file = required(args, 'file');
          const input = JSON.parse(readFileSync(file, 'utf8')) as SubmitPlanInput;
          print(submitPlan(db, goalId, input, one(args, 'by') ?? 'planner'));
          return;
        }
        if (subcommand === 'approve') {
          const planId = third;
          if (!planId) throw new Error('缺少计划 id');
          print(approvePlan(db, planId, required(args, 'by')));
          return;
        }
        if (subcommand === 'reject') {
          const planId = third;
          if (!planId) throw new Error('缺少计划 id');
          print(rejectPlan(db, planId, required(args, 'by'), one(args, 'reason') ?? ''));
          return;
        }
        if (subcommand === 'list' && third) {
          print(listPlansForGoal(db, third));
          return;
        }
        break;
      }

      case 'grant': {
        if (subcommand === 'list') {
          print(listGrantsForGoal(db, required(args, 'goal')));
          return;
        }
        break;
      }

      case 'escalation': {
        if (subcommand === 'list') {
          print(listEscalations(db, bool(args, 'pending') ? 'pending' : undefined));
          return;
        }
        if (subcommand === 'decide') {
          const id = third;
          if (!id) throw new Error('缺少升级 id');
          print(
            decideEscalation(db, id, {
              approver: required(args, 'by'),
              approve: !bool(args, 'deny'),
              reason: one(args, 'reason'),
              secondApprover: one(args, 'second'),
            }),
          );
          return;
        }
        if (subcommand === 'sweep') {
          print({ expired: sweepExpiredEscalations(db) });
          return;
        }
        break;
      }

      case 'auth': {
        if (subcommand === 'request') {
          const action = required(args, 'action');
          if (!isAction(action)) throw new Error(`未知动作：${action}`);
          const resource: ResourceRef = {};
          const repo = one(args, 'repo');
          const branch = one(args, 'branch');
          const path = one(args, 'path');
          const key = one(args, 'key');
          const host = one(args, 'host');
          if (repo) resource.repo = repo;
          if (branch) resource.branch = branch;
          if (path) resource.path = path;
          if (key) resource.key = key;
          if (host) resource.host = host;
          print(
            requestAction(db, {
              goalId: required(args, 'goal'),
              subject: required(args, 'subject'),
              action,
              resource,
            }),
          );
          return;
        }
        break;
      }

      case 'audit': {
        if (subcommand === 'log') {
          print(listAuditEvents(db, one(args, 'goal')));
          return;
        }
        if (subcommand === 'verify') {
          print(verifyAuditChain(db));
          return;
        }
        break;
      }

      default:
        break;
    }

    throw new Error(`未知命令：${args.positional.join(' ')}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`错误：${(error as Error).message}`);
  process.exitCode = 1;
}