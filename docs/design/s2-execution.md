# S2 隔离执行设计

> 状态：S2-01～S2-06 已实现（2026-11-03）· 对应 FR-05 / FR-06
> 依据：[P0 实现任务拆解](../p0-plan.md) 第 5 节 · 前置：[S1 治理内核设计](s1-governance.md)

S2 把执行者从"测试里的脚本"换成"可以被隔离、被约束、被替换的角色"。当前已覆盖工作区隔离、执行器契约、角色实例化、Builder 运行、提交/推送与失败重试。PR 创建在 P0 由人工完成。

## 1. 目标与非目标

**目标**

- 每个工作项拥有独立 worktree 与自有分支，并发工作项互不污染。
- 工作区的创建、查询、清理都有记录，异常后可回收。
- 执行器有稳定契约：成功、失败、超时、无法启动四种结果可判定。
- 角色按 playbook 装载，装载时校验其动作能力与 Grant 一致。
- Builder 在授权工作区内调用本地 CLI Agent，产出改动与自检结果。
- 提交与推送前再次经过网关，所有交付动作可审计。
- 同一原因连续失败两次转人工，环境失败不计入次数。

**非目标（留给后续任务）**

- 四类失败分类与恢复策略（S4-04；P0 只区分实现与环境）。
- PR 创建自动化与 PR 关联工作项（P0 人工创建 PR）。
- 独立验证上下文与证据采集（S3）。
- 按 token 的预算计量与耗尽暂停（S4-03）。

## 2. 新增模块与依赖

```text
src/
├── domain/
│   ├── types.ts       新增 Workspace 类型
│   └── executor.ts    执行器契约（纯类型，无运行时依赖）
├── infra/
│   ├── git.ts         git 命令适配与改动列表
│   ├── executor.ts    本地 CLI 执行器
│   ├── text.ts        输出尾部截断
│   └── db.ts          schema v2：workspaces 表
├── app/
│   ├── workspaces.ts  worktree 生命周期
│   ├── roles.ts       playbook 与角色实例化
│   ├── builder.ts     Builder 编排：Agent、自检、差异采集
│   ├── retries.ts     失败分类与重试状态
│   └── delivery.ts    commit / push
└── cli.ts             workspace / role / builder 子命令
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

## 6. Builder 运行（S2-04）

### 6.1 编排顺序

`runBuilder(db, input)` 的顺序固定，任一步失败都不会越过后面的门：

1. 读取目标与已批准计划，定位工作项；
2. `instantiateRole` 装载角色（校验状态、计划、Grant 与能力上限）；
3. 取活跃工作区；没有且传入 `repoDir` 时自动创建 worktree；
4. 向网关请求 `repo.write`（资源为仓库、分支与授权路径）；
5. 仅当放行才记 `builder.run_started` 并启动 Agent；
6. Agent 成功后运行自检命令；
7. 采集 `git status` 改动列表与 `git diff --stat`；
8. 记 `builder.run_finished`，返回摘要。

网关不放行时直接返回 `denied` 并记 `builder.run_denied`，Agent 一次都不会启动。

### 6.2 提示词与边界

提示词由目标、验收标准、工作项、预算、授权动作/分支/路径与 playbook 边界拼成，明确要求：

- 只在当前工作目录内修改文件；
- 不读取密钥、不合并 PR、不操作远端；
- 不自行 commit / push，交付由编排层统一处理。

提示词经 stdin 传给 Agent，避免长文本落到命令行参数里。

### 6.3 自检探测

默认读取工作区根目录的 `package.json`：

- 有 `pnpm-lock.yaml` 用 `pnpm`，否则用 `npm`；
- 存在 `typecheck` / `test` 脚本才运行，没有脚本不强行编造检查。

自检结果与 Agent 结果分开记录：Agent 非 `succeeded` 时不运行自检，避免把环境问题混入实现失败。

### 6.4 结果模型

| 状态 | 条件 |
| --- | --- |
| `succeeded` | Agent 成功且所有自检通过 |
| `failed` | Agent 失败，或任一自检未通过 |
| `denied` | 网关未放行 `repo.write` |

返回值同时包含 `changedFiles`、`diffStat`、角色实例与自检摘要，供 S3 验证消费。

## 7. 提交与推送（S2-05）

### 7.1 提交

`commitWorkspace` 的步骤：

1. 重新装载角色并取活跃工作区；
2. 无改动直接返回 `no_changes`；
3. 校验所有改动路径都在 Grant 的 `paths` 内，越界即拒绝（不写任何 git 状态）；
4. 请求网关 `repo.commit`（仓库 + 分支 + 授权路径）；
5. 放行后 `git add -A`、`git commit -m`，取 `HEAD` sha；
6. 记 `builder.committed`；拒绝则记 `builder.commit_denied`。

默认提交信息为 `manner: <工作项标题> (<id>)`，可用 `--message` 覆盖。

### 7.2 推送

`pushWorkspace` 请求网关 `repo.push`，放行后执行 `git push -u <remote> <branch>`，返回 `pushed` / `failed` / `denied`，并记录 `builder.pushed` 或 `builder.push_denied`。

P0 只保证分支可达；PR 由人工创建并关联工作项，自动化 PR 留给后续任务。

## 8. 失败重试（S2-06）

### 8.1 失败分类

P0 只区分两类，够用且不猜测：

| 类型 | 来源 | 是否计入实现者失败 |
| --- | --- | --- |
| `implementation` | Agent 非零退出、自检不通过 | 是 |
| `environment` | 超时、无法启动（`spawn_error`）、网络不可达 | 否 |

网络类失败按 Agent stderr 的关键词识别（`reconnecting`、`request timed out`、`stream disconnected`、`ECONNREFUSED`、`ENOTFOUND`、`ETIMEDOUT`、`EAI_AGAIN` 等），归为 `environment` 且 `causeKey` 记为 `agent:environment`。这是启发式判断，不做重试补偿。

同一原因用 `causeKey` 表示：`agent:failed`、`self-check:<name>` 等。四类完整分类与恢复策略留给 S4-04。

### 8.2 重试状态从审计推导

`assessBuilderRetry` 从审计链读取 `builder.run_finished`，不新增可变状态表：

- 从最新一条往前累计，成功即停止；
- 环境失败跳过，不计数也不打断连续性；
- `causeKey` 变化即停止；
- 连续同因失败达到 2 次，`blocked = true`。

`runBuilder` 在请求网关前检查该状态：已阻塞时不再启动 Agent，记 `builder.retry_blocked`，返回 `blocked` 让人类接手。

### 8.3 人工重置

`manner builder reset` 追加一条 `builder.retry_cleared`：只影响之后的重试计数，不删除任何历史失败与证据。重置后从零开始累计。

## 9. CLI

```bash
# 为工作项创建 worktree
manner workspace create --goal <goalId> --item build --repo-dir ~/src/demo \
  --worktree-root /tmp/manner-worktrees --by builder-1

# 查询与清理
manner workspace list --goal <goalId> --active
manner workspace cleanup <workspaceId> --delete-branch --by architect

# 装载角色（需计划已批准）
manner role instantiate --goal <goalId> --item build --by system

# 运行 Builder：缺工作区时自动创建，Agent 默认 codex
manner builder run --goal <goalId> --item build --repo-dir ~/src/demo --by builder-1

# 提交与推送（PR 由人工创建）
manner builder commit --goal <goalId> --item build --message "feat: ..." --by builder-1
manner builder push --goal <goalId> --item build --by builder-1

# 人工接手后重置重试计数（历史保留）
manner builder reset --goal <goalId> --item build --reason "已调整方案" --by human
```

`builder run` 默认执行 `codex exec --sandbox workspace-write`，提示词经 stdin 传入（不追加 `-` 参数，codex 0.147 不接受该占位符）；换 Agent 时用 `--agent` 与可重复的 `--agent-arg` 覆盖。

## 10. 测试映射

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
| S2-04 Builder 运行与自检 | `builder.test.ts` · Agent 在授权工作区内运行、自检并采集差异 |
| S2-04 无 `repo.write` 不启动 Agent | `builder.test.ts` · 没有 repo.write 授权时不启动 Agent |
| S2-04 失败不混入自检 | `builder.test.ts` · Agent 失败时不运行自检并返回失败原因 / 自检失败时整体判定为失败 |
| S2-04 自检命令探测 | `builder.test.ts` · 自检命令按 package.json 与锁文件探测 |
| S2-04 空改动判失败 | `builder.test.ts` · Agent 成功但没有改动时视为失败 |
| S2-05 提交与范围校验 | `delivery.test.ts` · 提交授权范围内的改动并写入审计 / 没有改动时返回 no_changes / 改动超出授权路径时拒绝提交 |
| S2-05 未授权提交被拒绝 | `delivery.test.ts` · 未获 repo.commit 授权时不写入 git 状态 |
| S2-05 推送与失败证据 | `delivery.test.ts` · 推送自有分支到远端 / 未获 repo.push 授权时不推送 / 远端不可达时推送标记为失败 |
| S2-06 同因两次转人 | `builder.test.ts` · 同一原因连续失败两次后转人工 |
| S2-06 环境失败不计入 | `builder.test.ts` · 环境失败不计入同因次数 |
| S2-06 网络类失败归为环境 | `builder.test.ts` · 网络类退出归为环境失败 |
| S2-06 换因不累积 | `builder.test.ts` · 不同失败原因不会累积 |
| S2-06 重置保留历史 | `builder.test.ts` · 人工重置后可以继续重试，历史仍保留 |

## 11. 已知边界

| 边界 | 现状 | 去向 |
| --- | --- | --- |
| 文件级写拦截 | 整次 run 以 `repo.write` 放行，靠 commit 前路径校验兜底 | 需要更细粒度时在网关前加文件钩子 |
| PR 创建 | 只推送分支，PR 由人工创建并关联工作项 | 后续接入 GitHub API |
| 失败分类 | 只区分实现与环境；非零退出默认视为实现失败，网络类靠 stderr 关键词启发式归为环境 | S4-04 |
| 转人后的恢复 | 需人工执行 `builder reset`，未自动创建升级单 | S4-04 |
| 预算计量 | 只把 `maxTokens` 带入角色实例，未累计真实消耗 | S4-03 |
| 多进程并发 | 同一工作项由数据库唯一索引兜底，未做跨进程租约 | 视需要 |
| worktree 回收 | 依赖显式 cleanup，未做目标取消时的自动回收 | S4-02 |
| 推送后验证 | 未自动确认远端分支与 PR 状态 | S3 / S2-07 |
| Agent 自带沙箱 | codex 的 `workspace-write` 依赖 bubblewrap；在缺少 `CAP_NET_ADMIN` 的容器里 bwrap 无法建回环，端到端改用 `danger-full-access`，隔离由 worktree 与网关承担 | 宿主具备 bwrap 时恢复 `workspace-write` |
| 空改动 | Agent 退出码 0 但没有任何文件改动时判为失败（`agent:no_changes`），避免"看起来成功" | 分析类工作项需要单独类型 |