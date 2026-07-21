import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatTokens, formatToolCall, isFailedResult } from "./render.ts";
import { getRun, summarizeValue } from "./state.ts";
import type { SingleResult, SubagentRunState } from "./types.ts";

interface ActiveDetailPage {
  close: () => void;
}

let activeDetailPage: ActiveDetailPage | null = null;

class AgentDetailComponent {
  private autoFollow = true;
  private disposed = false;
  private lastSignature = "";
  private scrollOffset = 0;
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: { requestRender(force?: boolean): void; terminal: { rows: number } },
    private readonly theme: Theme,
    private readonly getResult: () => SingleResult | undefined,
    private readonly onClose: () => void,
  ) {
    // 面板的刷新会被节流；详情页独立观察 run 状态，保证流式文本实时更新。
    this.refreshTimer = setInterval(() => this.refreshIfChanged(), 250);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onClose();
      return;
    }

    const pageSize = this.getPageSize();
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoFollow = false;
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset++;
      this.autoFollow = false;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
      this.autoFollow = false;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += pageSize;
      this.autoFollow = false;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.autoFollow = false;
    } else if (matchesKey(data, Key.end)) {
      this.autoFollow = true;
    } else if (data === "f" || data === "F") {
      this.autoFollow = !this.autoFollow;
    } else {
      return;
    }

    this.clampScroll();
    this.tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const result = this.getResult();
    const run = result ? getRun(result.runId) : undefined;
    const safeWidth = Math.max(1, width);
    const lines = this.buildHeader(result, run, safeWidth);
    const body = this.buildBody(result, run, safeWidth);
    const pageSize = this.getPageSize();
    const maxOffset = Math.max(0, body.length - pageSize);
    if (this.autoFollow) this.scrollOffset = maxOffset;
    else this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    lines.push(...body.slice(this.scrollOffset, this.scrollOffset + pageSize));
    const position =
      body.length > pageSize ? ` ${this.scrollOffset + 1}-${Math.min(body.length, this.scrollOffset + pageSize)}/${body.length}` : "";
    const follow = this.autoFollow ? "follow" : "paused";
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", ` ↑↓ scroll · PgUp/PgDn page · End follow · F ${follow} · Esc back${position}`),
        safeWidth,
      ),
    );
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.refreshTimer);
  }

  private refreshIfChanged(): void {
    if (this.disposed) return;
    const result = this.getResult();
    const signature = buildResultSignature(result, result ? getRun(result.runId) : undefined);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.clampScroll();
      this.tui.requestRender();
    }
  }

  private getPageSize(): number {
    // custom() 替换编辑区而非拥有精确可用高度，保守预留标题和帮助行。
    return Math.max(4, this.tui.terminal.rows - 9);
  }

  private clampScroll(): void {
    const result = this.getResult();
    const body = this.buildBody(result, result ? getRun(result.runId) : undefined, Number.MAX_SAFE_INTEGER);
    const maxOffset = Math.max(0, body.length - this.getPageSize());
    if (this.autoFollow) this.scrollOffset = maxOffset;
    else this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }

  private buildHeader(result: SingleResult | undefined, run: SubagentRunState | undefined, width: number): string[] {
    if (!result) return [truncateToWidth(this.theme.fg("error", " Subagent run is no longer available"), width)];

    const status = getStatus(result, run);
    const statusColor = status === "running" ? "warning" : status === "completed" ? "success" : "error";
    const elapsed = formatElapsed(run?.startTime ?? result.startTime, run?.endTime);
    const usage = run?.usage ?? result.usage;
    const model = run?.actualModel ?? result.model ?? "unknown model";

    const title = `${this.theme.bold(" Subagent ")}${this.theme.fg("accent", result.agent)} ${this.theme.fg(statusColor, status)}`;
    const metadata = this.theme.fg(
      "dim",
      ` model: ${model} · elapsed: ${elapsed} · tokens: ${formatTokens(usage.input)}↑/${formatTokens(usage.output)}↓`,
    );
    const task = this.theme.fg("muted", ` Task: ${result.task}`);
    const runId = result.runId ? this.theme.fg("dim", ` Run: ${result.runId}`) : "";
    return [title, metadata, truncateToWidth(task, width), truncateToWidth(runId, width), this.theme.fg("muted", " ─── Activity ───")].filter(Boolean);
  }

  private buildBody(result: SingleResult | undefined, run: SubagentRunState | undefined, width: number): string[] {
    if (!result) return [this.theme.fg("error", " Run was removed while this page was open.")];

    const lines: string[] = [];
    const pushWrapped = (text: string, color: "toolOutput" | "muted" | "error" = "toolOutput") => {
      const wrapped = wrapTextWithAnsi(this.theme.fg(color, text), Math.max(1, width - 2));
      lines.push(...wrapped.map((line) => ` ${line}`));
    };

    if (run) {
      for (const log of run.logs) pushWrapped(log.text, log.type === "error" ? "error" : "toolOutput");
      if (run.streamText.trim()) {
        lines.push(this.theme.fg("muted", " Streaming:"));
        pushWrapped(run.streamText);
      }
      if (run.toolCalls.length > 0) {
        lines.push(this.theme.fg("muted", " ─── Tool calls ───"));
        for (const tool of run.toolCalls) {
          const call = formatToolCall(tool.name, tool.args, this.theme.fg.bind(this.theme));
          lines.push(truncateToWidth(` ${this.theme.fg("muted", "→ ")}${call}`, width));
          const state = tool.status === "error" ? this.theme.fg("error", tool.status) : this.theme.fg("dim", tool.status);
          lines.push(truncateToWidth(`   ${state} · ${formatElapsed(tool.startTime, tool.endTime)}`, width));
          if (tool.partialResult !== undefined) pushWrapped(`partial: ${summarizeValue(tool.partialResult)}`, "muted");
          if (tool.result !== undefined) pushWrapped(`result: ${summarizeValue(tool.result)}`, tool.isError ? "error" : "muted");
        }
      }
    } else {
      for (const message of result.messages) {
        if (message.role === "assistant") {
          for (const part of message.content) {
            if (part.type === "text" && part.text) pushWrapped(part.text);
            if (part.type === "toolCall") {
              const call = formatToolCall(part.name, part.arguments, this.theme.fg.bind(this.theme));
              lines.push(truncateToWidth(` ${this.theme.fg("muted", "→ ")}${call}`, width));
            }
          }
        } else if (message.role === "toolResult") {
          const marker = message.isError ? this.theme.fg("error", "← ") : this.theme.fg("muted", "← ");
          lines.push(truncateToWidth(` ${marker}${this.theme.fg("accent", message.toolName)}`, width));
          for (const part of message.content) {
            if (part.type === "text" && part.text) pushWrapped(part.text, message.isError ? "error" : "muted");
          }
        }
      }
    }

    if (result.stderr) {
      lines.push(this.theme.fg("error", " stderr:"));
      pushWrapped(result.stderr, "error");
    }
    if (run?.errorMessage || result.errorMessage) lines.push(this.theme.fg("error", ` Error: ${run?.errorMessage ?? result.errorMessage}`));
    if (lines.length === 0) lines.push(this.theme.fg("dim", result.exitCode === -1 ? " Waiting for subagent output…" : " (no activity)"));
    return lines;
  }
}

function getStatus(result: SingleResult, run: SubagentRunState | undefined): "running" | "completed" | "failed" {
  if (run?.status === "running" || result.exitCode === -1) return "running";
  if (run && run.status !== "completed") return "failed";
  return isFailedResult(result) ? "failed" : "completed";
}

function formatElapsed(startTime: number | undefined, endTime?: number): string {
  if (!startTime) return "—";
  const seconds = Math.max(0, Math.floor(((endTime ?? Date.now()) - startTime) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function buildResultSignature(result: SingleResult | undefined, run: SubagentRunState | undefined): string {
  if (!result) return "missing";
  return JSON.stringify({
    exitCode: result.exitCode,
    stderr: result.stderr,
    errorMessage: result.errorMessage,
    usage: result.usage,
    messages: result.messages.at(-1),
    run: run && {
      status: run.status,
      endTime: run.endTime,
      streamText: run.streamText,
      logs: run.logs,
      toolCalls: run.toolCalls,
      usage: run.usage,
      errorMessage: run.errorMessage,
    },
  });
}

// showAgentDetailPage 打开当前子 Agent 的实时全屏详情页。
export function showAgentDetailPage(ctx: ExtensionContext, getResult: () => SingleResult | undefined): void {
  if (ctx.mode !== "tui" || activeDetailPage) return;

  let component: AgentDetailComponent | null = null;
  let closed = false;
  let done: (() => void) | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    component?.dispose();
    activeDetailPage = null;
    done?.();
  };

  void ctx.ui
    .custom<void>((tui, theme, _keybindings, finish) => {
      done = () => finish(undefined);
      component = new AgentDetailComponent(tui, theme, getResult, close);
      activeDetailPage = { close };
      return component;
    })
    .finally(() => {
      component?.dispose();
      if (activeDetailPage?.close === close) activeDetailPage = null;
    });
}

// closeAgentDetailPage 关闭已打开的子 Agent 详情页并释放它的刷新定时器。
export function closeAgentDetailPage(): void {
  activeDetailPage?.close();
}

// isAgentDetailPageOpen 返回是否正在显示子 Agent 详情页。
export function isAgentDetailPageOpen(): boolean {
  return activeDetailPage !== null;
}
