import { spawnSync } from 'node:child_process';

export interface TerminateResult {
  pid: number;
  ok: boolean;
  error?: string;
}

/**
 * 终止一个已经启动的子进程。
 *
 * Windows 用 taskkill /T 结束整棵进程树（Agent 常再启动子进程）；
 * 其他平台发送 SIGTERM。进程已退出视为成功。
 */
export function terminateProcess(pid: number): TerminateResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid, ok: false, error: '无效 PID' };
  }

  try {
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      if (result.status === 0) return { pid, ok: true };
      process.kill(pid, 'SIGTERM');
      return { pid, ok: true };
    }
    process.kill(pid, 'SIGTERM');
    return { pid, ok: true };
  } catch (error) {
    const message = (error as Error).message;
    if (/ESRCH|no such process|not found|找不到/i.test(message)) {
      return { pid, ok: true, error: message };
    }
    return { pid, ok: false, error: message };
  }
}