# Plan Workflow

`/plan 任务描述` 不再是一个开关式 mode，而是一台三阶段状态机，把规划到实施串起来：

1. **计划制定阶段**
   - 当前主 agent 临时切到 `Aurum`。
   - 禁用 `edit`/`write`，保留读代码能力，并启用 `subagent`。
   - planner 可以并行派发多个 `scout` agent，从不同模块/方案角度调研，最后输出 `Plan:` 编号步骤。
   - 步骤会按模块隔离性和任务复杂度拆分，方便后续并行实施；强依赖步骤应合并。

2. **澄清阶段**
   - 系统进入 clarifying 状态，主 agent 必须调用 `ask_user_question`。
   - 用户选择「实行当前计划」就进入实施阶段。
   - 用户选择「补充调整意见」或输入额外内容，就回到计划制定阶段，带着反馈重新出计划。
   - 这个循环可以持续多轮，直到用户确认实行。

3. **实施阶段**
   - 系统根据最终计划解析 todo。
   - 每个 todo 并行派发给一个 `developer` agent（`Argentum`）实现。
   - developer 只负责自己的步骤，避免互相抢改。

## Todo 解耦

Todo 已从 plan workflow 里拆出去，独立成为 `todo` 工具和命令：

| 入口 | 作用 |
|---|---|
| `todo` tool | LLM 可用的待办管理工具，支持 list/replace/add/complete/reopen/clear |
| `/todo add TEXT` | 手动新增 todo |
| `/todo done N` | 标记第 N 条完成 |
| `/todo reopen N` | 重新打开第 N 条 |
| `/todo clear` | 清空 todo |
| `/todos` | 查看当前 todo |
| `Ctrl+T` | 展开或收起 HUD todo 列表 |

`/plan` 只是在进入实施阶段时调用 todo controller 写入最终步骤，并在 developer 完成时标记完成；todo 本身不依赖 plan。

## 状态持久化

- Plan 文件：`.pi/taropi/plans/时间戳-plan.md`，只保存计划文本与当前状态。
- Todo 状态：会话 custom entry `todo-state`，由 todo 工具独立维护。
- `/resume` 后不会恢复正在运行的 planner/developer 子进程，只保留最近的计划文件信息和 todo 状态。
