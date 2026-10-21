# Plan Workflow / 会话级三态工作流

只有用户执行 `/plan 任务描述` 可以进入计划流程。模型可通过固定注册的 `plan` 工具提交、完成或退出，但不能自行进入。

## 状态与工具

| 阶段 | 默认模型 | 默认禁用工具 | 流转 |
|------|----------|-------------|------|
| 非 plan（idle） | 保持当前模型 | 无 | 只能由 `/plan` 进入 planning |
| 计划中（planning） | Au | edit、write | submit 经真实用户确认进入 implementing；exit 退出 |
| 实施中（implementing） | Ag | 无 | complete 完成；exit 退出 |

`Au/Ag` 使用已有模型别名配置，也支持 `Aurum/Argentum/Cuprum` 和 `provider/model-id`。进入 `/plan` 时直接切规划模型，不压缩；确认实施后先 compact，再切实施模型。退出或完成不切回旧模型。模型缺失、无凭证或切换失败时告警并沿用当前模型。用户中途手动切模型不被锁定，恢复时沿用 Pi 会话记录的模型。

工具声明始终不变，仅通过 `tool_call` 拦截。计划中可以使用 bash、查询或调研工具，但提示词明确要求**只能读，禁止实际修改本地或远程数据**。这不是只读沙箱，不解析 shell 命令做复杂校验；现有 permissions 规则继续生效。工作流自己保存 Markdown 是必要例外。

`plan` 的 action：

- `status`：返回当前阶段、规则、原始任务和完整计划；压缩或恢复后不确定阶段时可主动查询。
- `submit`：只在计划中接受包含编号步骤的完整计划，先保存正文，再弹窗询问“开始实施 / 补充内容”。补充反馈作为工具结果交给模型修订；Esc 或 Ctrl+C 取消确认后保持计划中。RPC 使用 select/input；无 UI 时不能批准实施。
- `complete`：只在已启动的实施阶段接受结果、验证与风险摘要，文件标记 completed 并回到 idle。
- `exit`：模型根据用户的自然语言退出请求调用，文件标记 exited 并回到 idle。

确认后直到实施提示实际送达之前，仍沿用计划阶段工具管控，防止同批后续写工具提前执行。`submit` 确认结果不内嵌实施提示；本轮完全收尾后，通过 compact 回调下发一次。取消压缩时保留待启动检查点，等用户再次输入；非取消的压缩失败告警后允许降级启动。

## Markdown 持久化

状态与正文在同一个文件，不创建额外状态 JSON，也不写会话 custom 条目。`/plan` 时立刻创建：

```text
.pi/taropi/plans/<任务摘要>-<UTC毫秒时间戳>-<随机后缀>.md
```

文件名创建后不再变化；随机后缀避免同一时间、相同任务覆盖。submit 后只更新正文标题。文件头示例：

```markdown
---
schema: 1
sessionId: "会话 ID"
status: "planning"
task: "原始任务"
adjustmentRounds: 0
pendingLaunch: false
createdAt: "2026-10-20T00:00:00.000Z"
updatedAt: "2026-10-20T00:00:00.000Z"
---

# 任务摘要或计划标题

## 计划详情

尚未提交
```

frontmatter 值按 JSON 字符串、数字和布尔序列化为合法 YAML，正文不重复状态和时间字段。每次更新先写同目录临时文件再 rename，失败时保留原文件、告警，内存流程继续。此时重启可能恢复旧检查点，尤其终态写入失败时可能重新发现旧活动计划。完成摘要另外保存到正文“实施结果”。

恢复会话或 `/reload` 时，扫描 `.md` 的 frontmatter，按 sessionId 匹配 planning/implementing，取 updatedAt 最新的有效文件（同时间按路径排序），再读取所选正文。无 frontmatter 的旧文件、临时文件、损坏或 schema 不匹配文件跳过；completed/exited 保留为非活动历史。扫描随文件数量线性增长。

## 中断与恢复

- Agent 正常停止、模型报错、Ctrl+C 中断和退出进程，都不自动完成或清空计划。
- 恢复只还原阶段、工具策略和 HUD，并提示一次，不自动发模型请求；下一次用户输入沿原阶段继续。
- 确认后若在实施提示送达前退出，pendingLaunch=true；恢复后的下一条输入合并一次实施规则、完整计划与用户输入。之后普通输入不再拼接规则。
- 未确认计划依赖 Pi 会话历史恢复调研上下文；Markdown 保留原始任务和最近提交正文。实施中断后先检查已有副作用，不能盲目重放工具。
- 不迁移旧 `plan-workflow` 会话条目。fork/clone 的 sessionId 不同，不继承活动状态；同一 sessionId 的 tree 分支共享会话级检查点。

## 用户阶段配置

可选文件 `getAgentDir()/plan.json`，默认 `~/.pi/agent/plan.json`。该配置 JSON 不是状态文件，不会自动创建或写回。

```json
{
  "planning": {
    "model": "Au",
    "blockedTools": ["edit", "write"]
  },
  "implementing": {
    "model": "Ag",
    "blockedTools": []
  },
  "idle": {
    "blockedTools": []
  }
}
```

每个阶段支持 `model`、`blockedTools`、`prompt`。prompt 完整替换默认阶段规则，任务、计划正文和路径仍由代码附加；应自行保留只读、确认和完成约束。model=null 关闭该阶段自动切换；idle 保持当前模型，不使用 model。blockedTools 是完整替换而非追加（空数组关闭该阶段拦截），不建议禁用 plan，否则模型无法流转。字段缺失或非法独立回退，配置缺失/损坏使用默认值。会话启动、恢复或进入 `/plan` 时重读配置，中途修改用 `/reload` 生效。

## 缓存边界与验证

每次阶段流转仅下发一次规则：/plan 用户消息、compact 后实施用户消息、complete/exit 工具结果。没有 `before_agent_start`、`context`、`turn_end` 注入，也不更改系统提示或工具列表。

进入 /plan 切 Au 可能使第一次请求 cache miss；确认后的切 Ag 与 compact 的前缀重建处于同一个阶段边界，但 compact 本身还会产生一次摘要请求。手动切模型也可能 miss。阶段内历史只追加，不保证不同 provider 的实际缓存命中。自动压缩可能摘要掉阶段规则，需要模型主动调用 status。

相邻 Vitest 测试覆盖配置、Markdown、流转、取消、失败降级及真实 AgentSession。SDK 使用模拟 provider 与模拟压缩结果，不访问真实用户配置或网络；断言阶段内请求前缀只追加、单次实施启动、模型切换和会话恢复。**发布前仍需真实 API 核对 cacheRead，SDK 通过不等于缓存验证通过。**

## 模块结构

- index：注册命令、固定工具、生命周期和 HUD。
- workflow：会话检查点、流转、异步启动与过期回调防护。
- types / config / prompts：类型、独立阶段配置和一次性规则。
- file：Markdown 元数据、固定文件名、原子写入和扫描恢复。
- runtime：阶段默认模型解析与安全降级。
- tool / tui：模型工具契约及用户确认交互。

临时体验（在仓库根目录执行，避免重复加载安装版扩展）：

```bash
pi -ne -e ./taropi-core/index.ts
```
