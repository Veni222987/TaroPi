---
description: 实现 + 审查 + 修复
---
使用 subagent 工具的 chain 模式执行：

1. 先用 "worker" agent 实现: "$@"
2. 再用 "reviewer" agent 审查上一步的所有改动（使用 {previous} 占位符）
3. 最后用 "worker" agent 根据审查意见修复问题（使用 {previous} 占位符）

以 chain 模式执行，通过 {previous} 在各步间传递输出。
