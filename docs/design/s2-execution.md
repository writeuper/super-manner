# S2 隔离执行设计（基础层）

> 状态：S2-01～S2-03 已实现（2026-11-03）· 对应 FR-05 / FR-06
> 依据：[P0 实现任务拆解](../p0-plan.md) 第 5 节 · 前置：[S1 治理内核设计](s1-governance.md)

S2 把执行者从"测试里的脚本"换成"可以被隔离、被约束、被替换的角色"。本轮只做不依赖外部凭据的基础层：工作区隔离、执行器契约、角色实例化。真实模型 CLI、提交与 PR 留到 S2-04 之后。

## 1. 目标与非目标

**目标**

- 每个工作项拥有独立 worktree 与自有分支，并发工作项互不污染。
- 工作区的创建、查询、清理都有记录，异常后可回收。
- 执行器有稳定契约：成功、失败、超时、无法启动四种结果可判定。
- 角色按 playbook 装载，装载时校验其动作能力与 Grant 一致。

**非目标（留给后续任务）**

- 调用真实模型 CLI、读取目标并自动实现（S2-04）。
- commit / push / PR 创建与产物登记（S2-05）。
- 失败分类与自动重试（S2-06 / S4-04）。
- 独立验证上下文与证据采集（S3）。

## 2. 新增模块与依赖

```text
src/
├── domain/
│   ├── types.ts       新增 Workspace 类型
│   └── executor.ts    执行器契约（纯类型，无运行时依赖）
├── infra/
│   ├── git.ts         git 命令适配
│   ├── executor.ts    本地 CLI 执行器
│   └── db.ts          schema v2：workspaces 表
├── app/
│   ├── workspaces.ts  worktree 生命周期
│   └── roles.ts       playbook 与角色实例化
└── cli.ts             workspace / role 子命令
```

依赖方向保持 `app → infra → domain`。`domain/executor.ts` 只有类型，不含 `node:child_process`；子进程实现放在 `infra`，便于替换为远程执行器或容器执行器。

## 3. 工作区隔离（S2-01）

### 3.1 数据模型

新增 `workspaces` 表（schema 版本 2）：

| 列 | 说明 |
| --- | --- |
| `id` | 工作区 id |
| `goal_id` / `work_item_id` | 归属 |
| `repo` | 逻辑仓库名（如 `acme/demo`） |
| `repo_dir` | 本地克隆的绝对路径 |
| `base_branch` | 拉出 worktree 的基线分支 |
| `branch` | 工作项自有分支 |
| `path` | worktree 绝对路径 |
| `status` | `active` / `removed` |
| `created_at` / `removed_at` | 时间 |

同一 `(goal_id, work_item_id)` 只允许一个 `active` 记录，由部分唯一索引保证。

### 3.2 分支与路径

- 分支：`feature/sm-<goal 前 8 位>-<workItemId>`，例如 `feature/sm-3f2a9c1e-build`。
- 该命名天然落在 S1 授权常见的 `feature/sm-*` 分支范围内，不需要额外放权。
- worktree 默认放在仓库同级的 `.manner-worktrees/<repo>/`，不污染主工作树；可用 `--worktree-root` 改写。
- 路径片段统一小写并只保留 `a-z0-9._-`，避免分支名与目录名互相污染。

### 3.3 生命周期

| 操作 | 行为 |
| --- | --- |
| 创建 | 校验目标处于 `executing` / `verifying`、计划已批准、工作项存在；`git worktree add -b` 后写库并记 `workspace.created` |
| 重复创建 | 同一工作项已有活跃工作区时直接返回，不重复拉取 |
| 查询 | `workspace list` 支持按目标与 `--active` 过滤 |
| 清理 | `git worktree remove`（可 `--force`）→ `worktree prune` → 按需 `branch -D` → 标记 `removed` 并记 `workspace.removed` |
| 写库失败 | 回滚刚创建的 worktree，避免留下无记录的目录 |

清理只保证本地干净；已推送的分支不受影响，远端分支由 PR 流程处理。

## 4. 执行器契约（S2-02）

`Executor` 只有一个方法：

```ts
interface Executor {
  readonly name: string;
  run(request: ExecutorRequest): Promise<ExecutorResult>;
}
```

请求包含 `command`、`args`、`cwd`、`env` 与 `timeoutMs`。结果的状态只有四种：

| 状态 | 判定 | 后续处理 |
| --- | --- | --- |
| `succeeded` | 退出码 0 | 进入下一步 |
| `failed` | 非 0 退出码 | 记录失败原因，交给 S2-06 分类 |
| `timed_out` | 超过 `timeoutMs` 仍未退出 | 先 `SIGTERM`，1 秒后 `SIGKILL`；不计为"实现失败" |
| `spawn_error` | 命令不存在或无权限启动 | 视为环境问题，不占用重试次数 |

其他约定：

- 结果包含 `stdout`、`stderr`、`startedAt`、`endedAt`、`durationMs`，可直接作为证据原料。
- 每个输出流默认最多保留 20 万字符，超出后追加 `...(输出已截断)`，避免证据无限膨胀。
- 本地实现 `createLocalExecutor()` 只负责跑命令；模型选择、prompt 组装与产物解析属于 S2-04。

## 5. 角色实例化（S2-03）

### 5.1 Playbook

`ROLE_PLAYBOOKS` 固定三种执行角色，每个 playbook 包含目标、步骤与边界：

| 角色 | 目标 | 关键边界 |
| --- | --- | --- |
| planner | 把目标拆成工作项，给出预算、风险与待决事项 | 不写代码、不越权申请、未批准不产生授权 |
| builder | 在授权范围内完成一个工作项并自检 | 不读密钥、不合并 PR、不越出仓库/分支/路径 |
| verifier | 独立判断验收标准是否满足 | 不复用实现者会话、不修改实现、不降低标准 |

playbook 刻意不写动作列表：动作权限的唯一真相是 Grant。两处都写会漂移。

### 5.2 装载校验

`instantiateRole(db, { goalId, workItemId })` 依次校验：

1. 目标处于 `executing` / `verifying`；
2. 存在已批准的计划，且工作项在计划里；
3. 工作项存在活跃 Grant；
4. Grant 的角色与工作项角色一致；
5. Grant 的每个动作都在 `ROLE_CAPS[role]` 内；
6. Grant 的仓库范围覆盖目标仓库。

任何一条不满足都拒绝装载。第 5 条是硬校验：即使数据库里出现越权脏数据，也不会被装载成角色。

装载成功后写入 `role.instantiated` 审计，返回实例：

```ts
interface RoleInstance {
  id: string;
  goalId: string;
  workItemId: string;
  role: 'planner' | 'builder' | 'verifier';
  subject: string;
  grantId: string;
  actions: Action[];
  scope: GrantScope;
  maxTokens?: number;
  playbook: RolePlaybook;
}
```

`subject` 取自 Grant，后续动作请求直接用它；网关仍会独立判定一次，装载不代表预授权。

## 6. CLI

```bash
# 为工作项创建 worktree
manner workspace create --goal <goalId> --item build --repo-dir ~/src/demo \
  --worktree-root /tmp/manner-worktrees --by builder-1

# 查询与清理
manner workspace list --goal <goalId> --active
manner workspace cleanup <workspaceId> --delete-branch --by architect

# 装载角色（需计划已批准）
manner role instantiate --goal <goalId> --item build --by system
```

## 7. 测试映射

| 任务 | 测试 |
| --- | --- |
| S2-01 分支命名符合 `feature/sm-*` | `workspaces.test.ts` · 分支命名落在 feature/sm-* 范围并包含工作项 |
| S2-01 创建隔离 worktree 并审计 | `workspaces.test.ts` · 为工作项创建独立 worktree 并写入审计 |
| S2-01 重复创建幂等 | `workspaces.test.ts` · 同一工作项重复创建返回已有工作区 |
| S2-01 并发工作项互不污染 | `workspaces.test.ts` · 不同工作项得到不同的 worktree 与分支 |
| S2-01 异常后可清理 | `workspaces.test.ts` · 清理工作区会移除目录、删除分支并保留记录 |
| S2-01 未批准目标与未知工作项被拒绝 | `workspaces.test.ts` · 未批准的目标不能创建工作区 / 计划里不存在的工作项不能创建工作区 |
| S2-02 四种执行结果 | `executor.test.ts` · 成功 / 非零退出 / 超时 / 命令不存在 |
| S2-02 上下文与输出上限 | `executor.test.ts` · cwd 与 env 生效 / 输出超过上限时截断 |
| S2-03 能力与授权一致 | `roles.test.ts` · 装载 builder / verifier |
| S2-03 越权脏数据被拒绝 | `roles.test.ts` · 授权动作超出角色上限时拒绝装载 |
| S2-03 授权失效与计划未批准 | `roles.test.ts` · 授权被吊销后不能装载角色 / 计划未经批准不能装载角色 |

## 8. 已知边界

| 边界 | 现状 | 去向 |
| --- | --- | --- |
| 真实执行 | 执行器可跑任意命令，但尚未接入模型 CLI | S2-04 |
| 提交与 PR | 未实现，worktree 只到"可写" | S2-05 |
| 失败分类 | 只区分超时/失败/启动错误，未区分实现与环境 | S2-06 / S4-04 |
| 预算计量 | 只把 `maxTokens` 带入角色实例 | S4-03 |
| 多进程并发 | 同一工作项由数据库唯一索引兜底，未做跨进程租约 | 视需要 |
| worktree 回收 | 依赖显式 cleanup，未做目标取消时的自动回收 | S4-02 |