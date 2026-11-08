import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalExecutor } from '../src/infra/executor.ts';

const executor = createLocalExecutor({ defaultTimeoutMs: 5000 });

test('Windows 批处理命令通过 cmd 启动', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manner-cmd-'));
  const script = join(dir, 'hello.cmd');
  writeFileSync(script, '@echo off\r\necho batch-ok\r\n', 'utf8');

  const result = await executor.run({ command: script, timeoutMs: 5000 });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(result.status, 'succeeded');
  assert.match(result.stdout, /batch-ok/);
});

test('成功命令返回 stdout 与退出码', async () => {
  const result = await executor.run({
    command: process.execPath,
    args: ['-e', "console.log('hello')"],
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
  assert.ok(result.durationMs >= 0);
  assert.ok(Date.parse(result.startedAt) <= Date.parse(result.endedAt));
});

test('非零退出码判定为失败', async () => {
  const result = await executor.run({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
});

test('超时命令被终止并标记 timed_out', async () => {
  const result = await executor.run({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 150,
  });

  assert.equal(result.status, 'timed_out');
  assert.ok(result.durationMs < 5000);
});

test('命令不存在标记 spawn_error', async () => {
  const result = await executor.run({ command: 'manner-command-does-not-exist-xyz' });

  assert.equal(result.status, 'spawn_error');
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT|not found/i);
});

test('cwd 与 env 生效', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'manner-executor-')));
  try {
    const result = await executor.run({
      command: process.execPath,
      args: ['-e', 'console.log(process.cwd()); console.log(process.env.MANNER_TEST)'],
      cwd: dir,
      env: { MANNER_TEST: 'ok' },
      timeoutMs: 5000,
    });

    assert.equal(result.status, 'succeeded');
    const [cwd, marker] = result.stdout.trim().split('\n');
    assert.equal(cwd, dir);
    assert.equal(marker, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('输出超过上限时截断', async () => {
  const small = createLocalExecutor({ maxOutputChars: 8 });
  const result = await small.run({
    command: process.execPath,
    args: ['-e', "process.stdout.write('0123456789abcdef')"],
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'succeeded');
  assert.match(result.stdout, /输出已截断/);
  assert.ok(result.stdout.length < 64);
});