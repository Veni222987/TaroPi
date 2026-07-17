/**
 * Subagent 模块级共享状态
 *
 * 数据流:
 *   engine runSingleAgent → startRun / updateRun / finishRun
 *   hud-panel / agent-panel  ←  getActiveRuns() / getSubAgentStates()
 *
 * Key 命名约定:
 *   engine 使用 `${agentName}:${step ?? Date.now()}` 作为唯一 key
 */

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 单条 sub-agent 的实时运行状态 */
export interface SubagentRunState {
  name: string;
  startTime: number;
  /** 别名解析后的实际模型 ID */
  actualModel: string;
  /** 最近一次工具调用名，无调用时为空串 */
  latestTool: string;
  tokens: { input: number; output: number };
  status: "running" | "completed" | "error";
}

/** @alias SubagentRunState（hud-panel 等旧消费者使用） */
export type SubAgentState = SubagentRunState;

// ---------------------------------------------------------------------------
// 模块级存储
// ---------------------------------------------------------------------------

const _store = new Map<string, SubagentRunState>();

// ---------------------------------------------------------------------------
// 写 API（engine → state）
// ---------------------------------------------------------------------------

/**
 * 注册一条新的 sub-agent 运行记录。
 * @param key   唯一标识
 * @param name  agent 名称
 * @param model 别名解析后的实际模型 ID
 * @param _step 可选的步骤编号（保留参数位）
 */
export function startRun(key: string, name: string, model: string, _step?: number): void {
  _store.set(key, {
    name,
    startTime: Date.now(),
    actualModel: model,
    latestTool: "",
    tokens: { input: 0, output: 0 },
    status: "running",
  });
}

/**
 * 更新指定 key 的运行状态（浅合并）。
 * key 不存在时静默忽略。
 */
export function updateRun(
  key: string,
  partial: {
    latestTool?: string;
    tokens?: { input: number; output: number };
  },
): void {
  const existing = _store.get(key);
  if (!existing) return;
  if (partial.latestTool !== undefined) existing.latestTool = partial.latestTool;
  if (partial.tokens) {
    existing.tokens.input = partial.tokens.input;
    existing.tokens.output = partial.tokens.output;
  }
}

/**
 * 将指定 key 标记为终态。
 */
export function finishRun(key: string, status: "completed" | "error"): void {
  const existing = _store.get(key);
  if (!existing) return;
  existing.status = status;
}

// ---------------------------------------------------------------------------
// 读 API（HUD / panel ← state）
// ---------------------------------------------------------------------------

/**
 * 按 startTime 降序返回当前所有运行记录（最新的在前）。
 * HUD 取前 3 条渲染 compact 行。
 */
export function getActiveRuns(): SubagentRunState[] {
  return Array.from(_store.values()).sort((a, b) => b.startTime - a.startTime);
}

/** @alias getActiveRuns（hud-panel 使用） */
export const getSubAgentStates = getActiveRuns;

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** 清除指定 key 的状态 */
export function clearRun(key: string): void {
  _store.delete(key);
}

/** 清空全部状态 */
export function clearAllRuns(): void {
  _store.clear();
}
