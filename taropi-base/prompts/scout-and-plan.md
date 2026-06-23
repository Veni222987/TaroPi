---
description: 侦查 + 规划（不实施）
---
使用 subagent 工具的 chain 模式执行：

1. 先用 "scout" agent 找到与 "$@" 相关的所有代码
2. 再用 "planner" agent 根据上一步的上下文为 "$@" 创建实现计划（使用 {previous} 占位符）

以 chain 模式执行，通过 {previous} 传递输出。**不要实施，只返回计划。**
