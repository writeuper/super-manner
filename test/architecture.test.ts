import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const DB_FILE = join(SRC, 'infra', 'db.ts');

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('领域层不依赖基础设施、应用层或数据库', () => {
  const domainDir = join(SRC, 'domain');
  for (const file of readdirSync(domainDir)) {
    if (!file.endsWith('.ts')) continue;
    const content = readFileSync(join(domainDir, file), 'utf8');
    assert.doesNotMatch(content, /from '\.\.\/(infra|app)\//, `${file} 不应依赖 infra/app`);
    assert.doesNotMatch(content, /node:sqlite/, `${file} 不应直接使用数据库`);
  }
});

test('数据库连接只在 infra/db.ts 中创建', () => {
  const offenders = listTypeScriptFiles(SRC).filter(
    (file) => file !== DB_FILE && readFileSync(file, 'utf8').includes('new DatabaseSync('),
  );
  assert.deepEqual(offenders, []);
});

test('动作词汇表固定为 15 个', async () => {
  const { ACTIONS } = await import('../src/domain/actions.ts');
  assert.equal(ACTIONS.length, 15);
  assert.equal(new Set(ACTIONS).size, 15);
});