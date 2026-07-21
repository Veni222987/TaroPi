import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { closeAgentDetailPage } from "./agent-detail.ts";
import { disposeAgentDetailNavigation, installAgentDetailNavigation } from "./agent-navigation.ts";
import { formatTokens, formatToolCall, getDisplayItems } from "./render.ts";
import { getRun } from "./state.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

export const AGENT_PANEL_KEY = "subagent-panel";
// 每张子 Agent 卡片总共严格占五行：一行标题/状态，四行滚动动态。
const CARD_DYNAMIC_LINES = 4;
const CARD_TOTAL_LINES = 5;
const WIDE_PANEL_MIN_WIDTH = 76;

type PanelMode = SubagentDetails["mode"];
type PanelResult = SingleResult & { __panelExecutionId?: string; __panelSlot?: number };

interface AgentPanelState {
  results: PanelResult[];
  /** -1 代表主 Agent；非负值对应 results 中的子 Agent。 */
  selectedIndex: number;
  /** 用户手动导航后，流式更新不应再抢走 Main/卡片焦点。 */
  navigationPinned: boolean;
  mode: PanelMode | null;
  widgetRequested: boolean;
  tui: { requestRender(force?: boolean): void } | null;
  theme: Theme | null;
}

const panelState: AgentPanelState = {
  results: [],
  selectedIndex: -1,
  navigationPinned: false,
  mode: null,
  widgetRequested: false,
  tui: null,
  theme: null,
};

// resultMatches 判断旧调用的两个工具结果是否代表同一个运行槽位。
function resultMatches(existing: PanelResult, incoming: SingleResult): boolean {
  if (existing.runId && incoming.runId) return existing.runId === incoming.runId;
  return (
    existing.agent === incoming.agent &&
    existing.task === incoming.task &&
    existing.step === incoming.step &&
    (!existing.runId || !incoming.runId)
  );
}

// mergeResults 将某次工具调用的更新并入当前总面板，按 executionId + 槽位隔离同名并发 Agent。
function mergeResults(incoming: SingleResult[], executionId?: string): void {
  for (let slot = 0; slot < incoming.length; slot++) {
    const result = incoming[slot]!;
    const index = executionId
      ? panelState.results.findIndex(
          (item) => item.__panelExecutionId === executionId && item.__panelSlot === slot,
        )
      : panelState.results.findIndex((item) => resultMatches(item, result));
    const next: PanelResult = { ...result, __panelExecutionId: executionId, __panelSlot: slot };
    if (index === -1) panelState.results.push(next);
    else panelState.results[index] = next;
  }
}

// padLine 将 ANSI 文本安全截断并补齐至卡片宽度。
function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, "", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

// formatElapsed 格式化运行时长。
function formatElapsed(startTime: number): string {
  const seconds = Math.floor(Math.max(0, Date.now() - startTime) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// statusIcon 返回结果或实时状态对应的状态图标。
function statusIcon(result: SingleResult, theme: Theme): string {
  const run = getRun(result.runId);
  const status = run?.status ?? (result.exitCode === -1 ? "running" : result.exitCode === 0 ? "completed" : "error");
  if (status === "running") return theme.fg("warning", "⏳");
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "aborted") return theme.fg("warning", "■");
  return theme.fg("error", "✗");
}

// getDynamicLines 返回卡片或全屏视图可消费的最新动态行。
export function getDynamicLines(result: SingleResult, theme: Theme, maxWidth: number): string[] {
  const run = getRun(result.runId);
  const lines: string[] = [];
  if (run) {
    for (const entry of run.logs) {
      for (const line of entry.text.split("\n")) {
        if (line) lines.push(theme.fg(entry.type === "error" ? "error" : "toolOutput", line));
      }
    }
    if (run.streamText) {
      for (const line of run.streamText.split("\n")) {
        if (line) lines.push(theme.fg("toolOutput", line));
      }
    }
  } else {
    for (const item of getDisplayItems(result.messages)) {
      if (item.type === "toolCall") {
        lines.push(theme.fg("muted", `→ ${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`));
      } else {
        for (const line of item.text.split("\n")) lines.push(theme.fg("toolOutput", line));
      }
    }
  }
  if (lines.length === 0) {
    lines.push(theme.fg("dim", result.exitCode === -1 ? "(starting…)" : "(no output)"));
  }
  return lines.map((line) => truncateToWidth(line, maxWidth, "", true));
}

// buildCardLines 生成总高五行的紧凑 Agent 卡片：一行状态和四行最新动态。
function buildCardLines(result: SingleResult, selected: boolean, theme: Theme, width: number): string[] {
  const run = getRun(result.runId);
  const name = result.agent.length > 18 ? `${result.agent.slice(0, 17)}…` : result.agent;
  const elapsed = run?.startTime ?? result.startTime;
  const tokenCount = run?.usage.output ?? result.usage.output;
  const meta = [elapsed ? `⏱${formatElapsed(elapsed)}` : "", tokenCount ? `↓${formatTokens(tokenCount)}` : ""]
    .filter(Boolean)
    .join(" ");
  const status = run?.status ?? (result.exitCode === -1 ? "running" : result.exitCode === 0 ? "completed" : "error");
  const color = selected ? "accent" : "muted";
  const title = `${selected ? "▸ " : "  "}${name} ${statusIcon(result, theme)} ${status}${meta ? ` ${meta}` : ""}`;
  const lines = [padLine(theme.fg(color, title), width)];
  const activity = getDynamicLines(result, theme, Math.max(1, width - 2)).slice(-CARD_DYNAMIC_LINES);
  for (const item of activity) lines.push(padLine(`  ${item}`, width));
  while (lines.length < CARD_TOTAL_LINES) lines.push(" ".repeat(width));
  return lines;
}

class AgentPanelComponent {
  invalidate(): void {}

  render(width: number): string[] {
    const { results, selectedIndex, mode, theme } = panelState;
    if (!theme || results.length === 0) return [];

    const columnCount = width >= WIDE_PANEL_MIN_WIDTH ? 2 : 1;
    const cardWidth = columnCount === 2 ? Math.floor((width - 3) / 2) : Math.max(1, width);
    const safeSelected = selectedIndex >= results.length ? -1 : selectedIndex;
    const running = results.filter((item) => item.exitCode === -1 || getRun(item.runId)?.status === "running").length;
    const mainLabel = safeSelected === -1 ? theme.fg("accent", "[Main]") : theme.fg("dim", "Main");
    const header = `${theme.fg("toolTitle", theme.bold("subagents"))} ${theme.fg("dim", mode ?? "")}  ${mainLabel}  ${theme.fg("dim", `${results.length} total · ${running} running`)}`;
    const hr = theme.fg("muted", "─".repeat(Math.max(1, width)));
    const lines = [truncateToWidth(header, Math.max(1, width), "", true), hr];

    // 同时只展示一组卡片：宽终端最多两个，窄终端一个；导航时窗口随选中项滑动。
    const firstVisible = safeSelected < 0 ? 0 : Math.floor(safeSelected / columnCount) * columnCount;
    const visible = results.slice(firstVisible, firstVisible + columnCount);
    const cards = visible.map((result, offset) =>
      buildCardLines(result, firstVisible + offset === safeSelected, theme, cardWidth),
    );
    for (let row = 0; row < CARD_TOTAL_LINES; row++) {
      if (columnCount === 1) {
        lines.push(cards[0]?.[row] ?? "");
      } else {
        const left = cards[0]?.[row] ?? " ".repeat(cardWidth);
        const right = cards[1]?.[row] ?? " ".repeat(cardWidth);
        lines.push(truncateToWidth(`${left}${theme.fg("muted", " │ ")}${right}`, Math.max(1, width), "", true));
      }
    }
    return lines;
  }
}

// showAgentPanel 显示或合并更新紧凑子 Agent 面板，并按调用 ID 隔离并发运行。
export function showAgentPanel(ctx: ExtensionContext, results: SingleResult[], mode: PanelMode): void;
export function showAgentPanel(
  ctx: ExtensionContext,
  executionId: string,
  results: SingleResult[],
  mode: PanelMode,
): void;
export function showAgentPanel(
  ctx: ExtensionContext,
  executionIdOrResults: string | SingleResult[],
  resultsOrMode: SingleResult[] | PanelMode,
  maybeMode?: PanelMode,
): void {
  if (ctx.mode !== "tui") return;
  const executionId = typeof executionIdOrResults === "string" ? executionIdOrResults : undefined;
  const results = (typeof executionIdOrResults === "string" ? resultsOrMode : executionIdOrResults) as SingleResult[];
  const mode = (typeof executionIdOrResults === "string" ? maybeMode : resultsOrMode) as PanelMode;
  const wasActive = isPanelActive();
  const widgetAlreadyRequested = panelState.widgetRequested;
  mergeResults(results, executionId);
  panelState.mode = mode;
  panelState.widgetRequested = true;
  installAgentDetailNavigation(ctx);
  if (!wasActive) {
    panelState.selectedIndex = -1;
    panelState.navigationPinned = false;
  }
  // setWidget 的工厂可能尚未执行；并发调用不能再次注册 widget 并丢掉已有卡片。
  if (widgetAlreadyRequested) {
    panelState.tui?.requestRender();
    return;
  }
  ctx.ui.setWidget(AGENT_PANEL_KEY, (tui, theme) => {
    panelState.tui = tui;
    panelState.theme = theme;
    return Object.assign(new AgentPanelComponent(), {
      dispose() {
        panelState.tui = null;
        panelState.theme = null;
        panelState.widgetRequested = false;
        panelState.results = [];
        panelState.selectedIndex = -1;
        panelState.mode = null;
        disposeAgentDetailNavigation();
      },
    });
  });
}

// refreshPanel 合并传入结果并请求重绘。
export function refreshPanel(results?: SingleResult[]): void {
  if (results) mergeResults(results);
  panelState.tui?.requestRender();
}

// updateAgentPanel 更新指定工具调用的所有槽位，不会覆盖同名并发 Agent。
export function updateAgentPanel(executionId: string, results: SingleResult[], selectedIndex?: number): void {
  mergeResults(results, executionId);
  // 初始焦点保持在 Main；仅当用户已在某个子 Agent 上且未手动固定导航时，
  // 才兼容旧调用把焦点同步到对应更新槽位。
  if (selectedIndex !== undefined && panelState.selectedIndex >= 0 && !panelState.navigationPinned) {
    const selected = panelState.results.findIndex(
      (item) => item.__panelExecutionId === executionId && item.__panelSlot === selectedIndex,
    );
    if (selected >= 0) panelState.selectedIndex = selected;
  }
  panelState.tui?.requestRender();
}

// refreshPanelWithIndex 兼容旧调用：更新结果后选中指定子 Agent。
export function refreshPanelWithIndex(results: SingleResult[], selectedIndex: number): void {
  mergeResults(results);
  if (!panelState.navigationPinned) {
    panelState.selectedIndex = Math.min(Math.max(-1, selectedIndex), panelState.results.length - 1);
  }
  panelState.tui?.requestRender();
}

// navigateAgent 在 Main 与所有子 Agent 之间循环选择。
export function navigateAgent(delta: number): boolean {
  if (!isPanelActive()) return false;
  const itemCount = panelState.results.length + 1;
  const current = panelState.selectedIndex + 1;
  panelState.selectedIndex = ((current + delta) % itemCount + itemCount) % itemCount - 1;
  panelState.navigationPinned = true;
  // 选回 Main 时立即释放详情页焦点，使编辑器重新接收输入。
  if (panelState.selectedIndex === -1) closeAgentDetailPage();
  panelState.tui?.requestRender();
  return true;
}

// navigateTab 兼容旧快捷键名称，实际行为改为 Main/子 Agent 循环导航。
export const navigateTab = navigateAgent;

// getSelectedAgentResult 返回当前选中的子 Agent；选中 Main 时返回 undefined。
export function getSelectedAgentResult(): SingleResult | undefined {
  return panelState.selectedIndex >= 0 ? panelState.results[panelState.selectedIndex] : undefined;
}

// isMainAgentSelected 判断当前导航是否位于主 Agent。
export function isMainAgentSelected(): boolean {
  return panelState.selectedIndex === -1;
}

// getAgentResultByRunId 使用稳定 runId 获取当前面板内的实时结果。
export function getAgentResultByRunId(runId: string): SingleResult | undefined {
  return panelState.results.find((result) => result.runId === runId);
}

// isPanelActive 判断紧凑子 Agent 面板是否正在显示。
export function isPanelActive(): boolean {
  return panelState.mode !== null && panelState.results.length > 0 && panelState.widgetRequested;
}

// closeAgentPanel 清理面板状态并移除对应 widget。
export function closeAgentPanel(ctx: ExtensionContext): void {
  disposeAgentDetailNavigation();
  panelState.results = [];
  panelState.selectedIndex = -1;
  panelState.navigationPinned = false;
  panelState.mode = null;
  panelState.widgetRequested = false;
  ctx.ui.setWidget(AGENT_PANEL_KEY, undefined);
}
