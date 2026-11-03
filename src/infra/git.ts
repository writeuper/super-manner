import { spawnSync } from 'node:child_process';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** 同步执行 git：工作区操作不频繁，同步实现更容易保证顺序。 */
export function runGit(args: string[], options: { cwd?: string } = {}): GitResult {
  const result = spawnSync('git', args, { cwd: options.cwd, encoding: 'utf8' });
  if (result.error) throw new Error(`git 执行失败：${result.error.message}`);
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runGitOrThrow(args: string[], options: { cwd?: string } = {}): GitResult {
  const result = runGit(args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(' ')} 失败：${detail || `退出码 ${result.status}`}`);
  }
  return result;
}

export function isGitRepository(dir: string): boolean {
  const result = runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return result.status === 0 && result.stdout.trim() === 'true';
}

export function refExists(repoDir: string, ref: string): boolean {
  return runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repoDir }).status === 0;
}

export function branchExists(repoDir: string, branch: string): boolean {
  return refExists(repoDir, `refs/heads/${branch}`);
}