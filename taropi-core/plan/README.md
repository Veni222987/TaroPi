# Plan Workflow / 三阶段状态机

`/plan 任务描述` 不再是一个开关式 mode，而是一台三阶段状态机，把规划到实施串起来：

1. **计划制定阶段**
   - 当前主 agent 临时切到 `Aurum`。
   - 禁用 `edit`/`write`，保留读代码能力，并启用 `subagent`。
   - planner 可以并行派发多个 `scout` agent，从不同模块/方案角度调研，最后输出 `Plan:` 编号步骤。
   - 步骤会按模块隔离性和任务复杂度拆分，方便后续并行实施；强依赖步骤应合并。

2. **澄清阶段**
   - 计划生成后，代码直接弹出选择框（`ask-user-question.ts`），不经过 LLM。
   - 用户选择「开始实现」就进入实施阶段。
   - 焦点移到「补充内容」行即可直接打字（可留空直接回车），回车提交后回到计划制定阶段，带着反馈重新出计划。
   - 这个循环可以持续多轮，直到用户选择「开始实现」。

3. **实施阶段**
   - 系统根据最终计划解析 todo。
   - 每个 todo 并行派发给一个 `developer` agent（`Argentum`）实现。
   - developer 只负责自己的步骤，避免互相抢改。

## 文件结构

```
plan/
├── index.ts              # 装配层：状态机定义、阶段提示词、runtime 切换、持久化、developer 派发、HUD、命令与事件钩子
├── ask-user-question.ts  # 澄清阶段选择框：自绘 ctx.ui.custom 弹窗，样式照抄 rpiv-ask-user-question 的扁平编号列表，「补充内容」行落焦即可直接输入，不经过 LLM 工具调用
├── utils.ts               # 纯函数：计划文本解析、计划 markdown 落盘
└── README.md              # 本文档
```

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

## 运行时 Key（勿改，保证旧会话兼容）

| Key | 用途 |
|---|---|
| `plan-workflow` | persist entry type（兼作 HUD 面板 key） |
| `plan-workflow-context` | 规划阶段注入的 customType（当前） |
| `plan-with-todo-context` | 旧版注入的 customType，仅 context 事件过滤用，只读不写 |
