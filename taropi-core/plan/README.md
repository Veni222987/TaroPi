# Plan Workflow / 三阶段状态机

`/plan 任务描述` 是一台三阶段状态机，负责把需求调研、计划确认和实际实施串成一个完整闭环：

1. **计划制定阶段**
   - 当前主 agent 临时切到 `Aurum`。
   - 禁用 `edit`/`write`，保留读代码能力（`read`/`bash`/`grep`/`find`/`ls`）。
   - planner 独立完成调研到出计划的全流程，最后输出 `Plan:` 编号步骤。
   - 每个步骤应是原子、独立的修改单元。

2. **澄清确认阶段**
   - 计划生成后，代码直接弹出选择框（`ask-user-question.ts`）。
   - 用户选择「开始实施」后进入实施阶段；焦点移到「补充内容」行即可直接打字（可留空直接回车），回车提交后回到计划制定阶段，带着反馈重新出计划。
   - 这个循环可以持续多轮，直到用户选择「开始实施」。

3. **主 Agent 实施阶段**
   - 恢复用户进入 `/plan` 前的模型，并恢复 `edit`/`write` 等正常工具能力。
   - 主 Agent 直接按已确认计划修改代码、运行必要校验并汇报结果。
   - 本轮 Agent 结束后，计划文件标记为已完成，并恢复用户原始完整工具集。

计划文件会持久化到 `.pi/taropi/plans/`，可用于审阅和追溯。

## 文件结构

```
plan/
├── index.ts              # 装配层：状态机定义、阶段提示词、runtime 切换、主 Agent 实施、持久化、HUD、命令与事件钩子
├── ask-user-question.ts  # 澄清阶段选择框：自绘 ctx.ui.custom 弹窗，扁平编号列表，「补充内容」行落焦即可直接输入
├── utils.ts               # 纯函数：计划文本解析、计划 markdown 落盘
└── README.md              # 本文档
```

## 状态持久化

- Plan 文件：`.pi/taropi/plans/时间戳-plan.md`，只保存计划文本与当前状态。
- `/resume` 后不会恢复正在运行的 planner/implementing 轮次，只保留最近的计划文件信息。

## 运行时 Key（勿改，保证旧会话兼容）

| Key | 用途 |
|---|---|
| `plan-workflow` | persist entry type（兼作 HUD 面板 key） |
| `plan-workflow-context` | 规划阶段注入的 customType |
