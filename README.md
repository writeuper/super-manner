# Super-Manner

> Autonomous coding agents with manners — scoped by grants, proven by evidence, improved by review.
>
> 有章法的 Agent 团队：目标可委任，越界有裁决，交付有证据。

Super-Manner 是一个协作式 coding agent 团队。架构师提交目标与验收标准，系统自行组队、分工、执行与验证，交付可审查的 PR 和完整证据；每次交付后，团队依据评测结果受控地变强一点。

## 核心主张

- **目标所有权**：委派单元是目标，不是任务。系统自己决定怎么做，并对结果负责。
- **可验证的完成**：完成由证据定义，不由实现者自评定义。
- **可回滚的授权**：动作级授权随目标签发与失效，越界由运行时拒绝并要求人裁决。
- **受控的自我迭代**：复盘产出版本化提案，经黄金任务集评测与灰度后才生效。

自主性不是“让 Agent 更敢做”，而是同时具备以上四件事；缺任何一项，自主性都会变成风险。

## 当前状态

治理内核（S1）、隔离执行（S2）与验证验收（S3）已可运行：Builder 在独立 worktree 内改动、自检、提交并推送分支，Verifier 依据差异与证据逐条判定，人工在验收视图上接受或返工；S4 已补齐暂停恢复、取消级联、预算计量与失败分类。交付闭环已补全：改动在运行、提交、推送三处校验授权路径，越界即阻断并生成升级卡片；PR 通过 `manner builder pr` 调用 gh CLI 自动创建，幂等且写入审计。验证阶段现在有明确入口 `manner verify start`，完成判定会核对证据采集批次、返工轮次、最新提交与已推送提交；`manner verify submit` 将达标目标送入待验收队列；取消目标会终止仍在运行的 Agent，工作项依赖也会参与调度。`manner orchestrate ready/next` 给出就绪队列，同一目标默认只运行一个 Agent，下游工作项以上游分支为起点。角色的 Playbook 也已版本化：变更须经黄金任务集评测、通过率与回归门禁、提案人不得自批，再按 canary 灰度或全量生效，并可回滚到上一稳定版本。已在私有沙箱仓库完成一次真实 GitHub 链路演练（脚本 Agent），PR 与审计记录可复核。

- [x] 产品定位与命名
- [x] 产品需求文档 v0.2（决定稿）
- [x] 8 项开放问题定稿（预算单位、第二人规则、默认自治级别等）
- [x] S1 治理内核：目标、授权、越界拦截、升级裁决、审计链（41 项测试通过）
- [x] S2 隔离执行：worktree、Executor、角色实例化、Builder 运行、commit/push、失败重试（累计 81 项测试通过）
- [x] S2 端到端：真实模型在 `feature/sm-179ad8f6-build` 上改 README 并推送（当时 PR 为人工创建，现已由 `manner builder pr` 自动化）
- [x] S3 验证与验收：证据与人工决定（S3-01～S3-07 完成，累计 96 项测试通过）
- [x] S4 生命周期与归档：暂停、取消、预算与复盘（S4-01～S4-07 完成，含完整旅程演练，累计 117 项测试通过）
- [x] 交付闭环：改动范围三处校验、gh PR 自动创建（幂等、审计、拒绝/阻断分支，累计 124 项测试通过）
- [x] FR-11 受控自我迭代：黄金任务集、playbook 版本化、评测门禁、canary 灰度与回滚（累计 131 项测试通过）
- [x] 闭环缺口修复：`verify start/submit`、证据批次与返工轮次绑定、推送门禁、取消终止与依赖调度（累计 148 项测试通过）
- [x] P1 工作项编排首块：`orchestrate ready/next`、单目标并发上限、失败状态与下游基于上游分支
- [x] 真实 GitHub 链路演练（脚本 Agent）：PR #1、交付 SHA、证据、待验收队列、人工接受与复盘（[记录](docs/rehearsal/p0-2026-11-08.md)）

## 本地运行

```bash
pnpm install
pnpm run typecheck   # TypeScript strict，P0 的静态检查（lint）基线
pnpm test
pnpm manner --help
```

push 与 PR 会触发 GitHub Actions 执行同样的安装、类型检查与测试。

## 受控自我迭代（FR-11）

Playbook 的每次变更都走同一条治理路径：提案 → 黄金任务集评测 → 门禁 → 灰度/生效 → 可回滚。

```bash
manner playbook golden import --file golden.json --by <id>   # 导入黄金任务集
manner playbook propose --role builder --file playbook.json --by <id> [--rationale <text>]
manner playbook evaluate <proposalId> --file results.json --by <id>  # 外部运行结果 + 门禁计算
manner playbook promote <proposalId> --by <id> [--canary 10]         # 全量或灰度生效
manner playbook versions [--role builder]
manner playbook rollback --role builder --by <id> [--reason <text>]
```

评测结果由外部运行黄金任务后以 JSON 导入，系统负责通过率、任务覆盖、相对当前版本的回归检测与晋级门禁；提案人不能自批。生效版本会记录到角色实例（`playbookVersionId` 与 `playbookChannel`），未激活版本时回退内置 playbook。

## 文档

| 文档 | 说明 |
| --- | --- |
| [产品需求文档 v0.2](docs/prd-v0.2.html) | 自包含 HTML，浏览器直接打开；定义产品行为与边界，不含技术架构 |
| [P0 实现任务拆解](docs/p0-plan.md) | 按 FR 拆分的四个切片与验收场景 |
| [S1 治理内核设计](docs/design/s1-governance.md) | 分层、状态机、授权判定、网关流程、CLI 与测试映射 |
| [S2 隔离执行设计](docs/design/s2-execution.md) | worktree 隔离、执行器契约、角色 playbook、Builder 运行与提交/推送 |
| [S3 验证与验收设计](docs/design/s3-verification.md) | 独立上下文、证据、逐条判定、完成判定、验收视图与验收决定 |
| [S4 生命周期与归档设计](docs/design/s4-lifecycle.md) | 暂停/恢复状态、检查点、预算计量、失败分类与恢复策略、复盘汇总、审计查询与待办、P0 演练 |

## 术语

| 术语 | 含义 |
| --- | --- |
| Goal | 一次委派，包含验收标准、约束、预算与自治级别 |
| WorkItem | 可独立执行与验证的最小单元 |
| Grant | 动作、资源、约束的组合，随目标签发与失效，不可转授 |
| Escalation | 有资格但超限时请求人裁决，一次一用 |
| Evidence | 可复现、可核对、可归属的事实，是“完成”的唯一依据 |
| Playbook | 角色行为的版本化载体，变更需经评测与灰度 |

完整定义见 PRD 第 4 章与附录 11.2。

## 命名约定

| 场景 | 写法 |
| --- | --- |
| 产品名 | Super-Manner |
| 仓库 / 包名 | `super-manner` |
| CLI | `manner` |
| 中文简称 | 章法 |

## 许可证

[Apache License 2.0](LICENSE)