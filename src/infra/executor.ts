import { spawn } from 'node:child_process';
import type { Executor, ExecutorRequest, ExecutorResult, ExecutorStatus } from '../domain/executor.ts';

export interface LocalExecutorOptions {
  name?: string;
  defaultTimeoutMs?: number;
  /** 单个输出流保留的最大字符数，超出部分截断，避免证据无限膨胀。 */
  maxOutputChars?: number;
}

/**
 * 本地 CLI 执行器。
 *
 * 用子进程跑任意命令（模型 CLI、构建、测试都行），只负责给出可判定的结果：
 * 退出码 0 为成功，超时单独标记，命令不存在记为 spawn_error。
 */
export function createLocalExecutor(options: LocalExecutorOptions = {}): Executor {
  const name = options.name ?? 'local-cli';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const maxOutputChars = options.maxOutputChars ?? 200_000;

  return {
    name,
    run(request: ExecutorRequest): Promise<ExecutorResult> {
      return new Promise((resolve) => {
        const startedAt = new Date();
        const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const append = (current: string, chunk: string): string => {
          if (current.length >= maxOutputChars) return current;
          const next = current + chunk;
          return next.length > maxOutputChars
            ? `${next.slice(0, maxOutputChars)}\n...(输出已截断)`
            : next;
        };

        const finish = (status: ExecutorStatus, exitCode: number | null, signal: string | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          const endedAt = new Date();
          resolve({
            status,
            exitCode,
            signal,
            stdout,
            stderr,
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          });
        };

        const child = spawn(request.command, request.args ?? [], {
          cwd: request.cwd,
          env: { ...process.env, ...request.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // 子进程可能不读取 stdin 就退出，忽略 EPIPE。
        child.stdin.on('error', () => {});
        child.stdin.end(request.stdin ?? '');

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout = append(stdout, chunk);
        });
        child.stderr.on('data', (chunk: string) => {
          stderr = append(stderr, chunk);
        });

        child.on('error', (error) => {
          stderr = append(stderr, error.message);
          finish('spawn_error', null, null);
        });

        child.on('close', (code, signal) => {
          finish(timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed', code, signal);
        });

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
              child.kill('SIGKILL');
            }, 1000);
          }, timeoutMs);
        }
      });
    },
  };
}