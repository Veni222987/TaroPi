/**
 * SubagentStore - 共享状态中枢，连接 sub-agents 执行引擎与 HUD 看板。
 * sub-agents/index.ts 写入，HudPanel 和 detail-overlay 读取。
 */
import type { SingleResult } from "../sub-agents/types.ts";

export interface SubagentBatch {
  batchId: number;
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
  selectedIndex: number;
  startTime: number;
  endTime?: number;
  /** per-agent 耗时：index → { start, end? } */
  timings: Map<number, { start: number; end?: number }>;
}

let batch: SubagentBatch | null = null;
let nextBatchId = 1;
const refreshListeners = new Set<() => void>();

/**
 * initBatch 初始化新批次，用占位结构填充 results，等待 updateBatchResult 写入真实数据。
 * placeholders 中 exitCode 默认 -1（运行中哨兵值）。
 */
export function initBatch(
  mode: SubagentBatch["mode"],
  placeholders: Pick<SingleResult, "agent" | "agentSource" | "task">[],
): void {
  const results: SingleResult[] = placeholders.map((p) => ({
    ...p,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  }));
  batch = {
    batchId: nextBatchId++,
    mode,
    results,
    selectedIndex: 0,
    startTime: Date.now(),
    timings: new Map(),
  };
  _notify();
}

/** updateBatchResult 写入单个 agent 的最新结果，自动维护 per-agent timing */
export function updateBatchResult(index: number, result: SingleResult): void {
  if (!batch) return;
  const timing = batch.timings.get(index) ?? { start: Date.now() };
  if (result.exitCode !== -1 && !timing.end) timing.end = Date.now();
  batch.timings.set(index, timing);
  batch.results[index] = result;
  _notify();
}

/** completeBatch 标记整批完成时间 */
export function completeBatch(): void {
  if (!batch) return;
  batch.endTime = Date.now();
  _notify();
}

/** navigateBatchTab 循环移动 selectedIndex，并触发刷新 */
export function navigateBatchTab(delta: number): void {
  if (!batch || batch.results.length === 0) return;
  batch.selectedIndex =
    (batch.selectedIndex + delta + batch.results.length) % batch.results.length;
  _notify();
}

/** getBatch 返回当前批次，无批次时返回 null */
export function getBatch(): SubagentBatch | null {
  return batch;
}

/** isBatchActive 是否有批次数据（含已完成） */
export function isBatchActive(): boolean {
  return batch !== null && batch.results.length > 0;
}

/**
 * addRefreshListener 注册刷新回调，返回取消注册函数。
 * HudPanel 和 DetailOverlay 各注册一个，store 更新时自动调用。
 */
export function addRefreshListener(fn: () => void): () => void {
  refreshListeners.add(fn);
  return () => refreshListeners.delete(fn);
}

function _notify(): void {
  for (const fn of refreshListeners) {
    try {
      fn();
    } catch {
      /* 忽略监听器异常，避免单个监听器崩溃影响其他 */
    }
  }
}
