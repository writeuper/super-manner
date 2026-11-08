/**
 * 执行器契约。
 *
 * 只描述"跑一个本地命令并给出可判定结果"，不绑定任何模型或 CLI。
 * 真实 Agent、构建命令、验证命令都通过这个接口发起，便于替换实现。
 */

export type ExecutorStatus = 'succeeded' | 'failed' | 'timed_out' | 'spawn_error';

export interface ExecutorRequest {
  command: string;
  args?: string[];
  cwd?: string;
  /** 追加/覆盖当前进程的环境变量；不传则继承。 */
  env?: Record<string, string | undefined>;
  /** 写入子进程标准输入，便于传递长提示词，避免命令行长度限制。 */
  stdin?: string;
  timeoutMs?: number;
  /** 子进程启动后回调 PID，便于取消目标时终止运行中的 Agent。 */
  onSpawn?: (pid: number) => void;
}

export interface ExecutorResult {
  status: ExecutorStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface Executor {
  readonly name: string;
  run(request: ExecutorRequest): Promise<ExecutorResult>;
}