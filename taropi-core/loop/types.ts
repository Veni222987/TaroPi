/**
 * loop 模块的持久化数据结构
 */

export interface LoopConfig {
  name: string;
  /** 复用 sub-agents/agents.ts 的 agent 定义名 */
  agent: string;
  /** 已解析好的 provider/id，undefined 表示沿用当前会话默认模型 */
  model?: string;
  /** 沿用 agent 定义里的 tools（未设置则不传 --tools，走默认全量工具） */
  tools?: string[];
  /** 用户输入的原始间隔，如 "30m" / "2h" / 原始 5 段 cron 表达式 */
  interval: string;
  /** 展开后的 5 段 cron 表达式 */
  cronExpr: string;
  cwd: string;
  createdAt: string;
}
