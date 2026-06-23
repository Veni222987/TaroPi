---
description: 完整实现流程 - 侦查员收集上下文，规划师制定计划，worker 执行实现
---
使用 subagent 工具的 chain 模式执行：

1. 先用 "scout" agent 找到与 "$@" 相关的所有代码
2. 再用 "planner" agent 根据上一步的上下文为 "$@" 创建实现计划（使用 {previous} 占位符）
3. 最后用 "worker" agent 根据上一步的计划实施（使用 {previous} 占位符）

以 chain 模式执行，通过 {previous} 在各步间传递输出。
