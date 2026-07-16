/**
 * DetailOverlay - Sub-agent react 全屏详情 overlay。
 * 用 ctx.ui.custom({ overlay: true }) 弹出，Component.handleInput 接管键盘。
 * 实时刷新：订阅 subagent-store 的更新通知，每次 update 调 tui.requestRender()。
 */
import type { Component } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  addRefreshListener,
  getBatch,
  isBatchActive,
  navigateBatchTab,
} from "../hud/subagent-store.ts";
import {
  c, dim,
  FG, COMMENT, GREEN, ORANGE, CYAN, PURPLE, YELLOW, BLUE, PINK, R,
  DIVIDER, SEP,
  fmtDuration,
} from "../hud/theme.ts";
import { formatTokens, formatToolCall, getDisplayItems, isFailedResult } from "./render.ts";

// pi Theme 颜色键 → HUD ANSI 颜色映射（供 formatToolCall 使用）
const PI_TO_ANSI: Record<string, string> = {
  muted:     COMMENT,
  dim:       COMMENT,
  toolOutput: FG,
  accent:    CYAN,
  warning:   YELLOW,
  error:     PINK,
  success:   GREEN,
  toolTitle: BLUE,
};
const themeFg = (color: unknown, text: string): string =>
  c(text, PI_TO_ANSI[color as string] ?? FG);

class DetailOverlayComponent implements Component {
  private scrollOffset = 0;
  private contentLength = 0;
  private readonly renderHeight = 28;   // 固定内容视口行数，防抖动
  private unsubscribe: () => void;

  constructor(private readonly tui: TUI, private readonly done: (r: void) => void) {
    // 订阅 store：sub-agent 每次更新都触发重绘
    this.unsubscribe = addRefreshListener(() => this.tui.requestRender());
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("g"))) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "ctrl+shift+[")) {
      navigateBatchTab(-1);
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, "ctrl+shift+]")) {
      navigateBatchTab(1);
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(
        Math.max(0, this.contentLength - this.renderHeight),
        this.scrollOffset + 1,
      );
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.renderHeight);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(
        Math.max(0, this.contentLength - this.renderHeight),
        this.scrollOffset + this.renderHeight,
      );
      this.tui.requestRender();
      return;
    }
  }

  render(_width: number): string[] {
    const batch = getBatch();
    if (!batch) return [];

    const sep = SEP;
    const lines: string[] = [];

    // ── 汇总头 ──
    const running = batch.results.filter((r) => r.exitCode === -1).length;
    const doneCnt = batch.results.filter((r) => r.exitCode !== -1).length;
    const total = batch.results.length;
    const elapsed = fmtDuration(
      (batch.endTime ?? Date.now()) - batch.startTime,
    );
    const agg = batch.results.reduce(
      (acc, r) => {
        acc.input += r.usage.input;
        acc.output += r.usage.output;
        acc.cost += r.usage.cost;
        return acc;
      },
      { input: 0, output: 0, cost: 0 },
    );
    const statusStr =
      running > 0
        ? `${doneCnt}/${total} done · ${running} running`
        : `${doneCnt}/${total} done`;
    const usageParts: string[] = [];
    if (agg.input)  usageParts.push(`↑${formatTokens(agg.input)}`);
    if (agg.output) usageParts.push(`↓${formatTokens(agg.output)}`);
    if (agg.cost)   usageParts.push(`$${agg.cost.toFixed(3)}`);

    lines.push(
      [
        `${c("⚡", YELLOW)} ${c(batch.mode, ORANGE)}`,
        c(statusStr, running > 0 ? YELLOW : GREEN),
        ...(usageParts.length ? [c(usageParts.join(" "), COMMENT)] : []),
        c(elapsed, CYAN),
      ].join(` ${sep} `),
    );

    // ── tab 条 ──
    const tabs = batch.results.map((r, i) => {
      const icon =
        r.exitCode === -1
          ? c("⏳", YELLOW)
          : isFailedResult(r)
            ? c("✗", PINK)
            : c("✓", GREEN);
      const name = r.agent.length > 12 ? `${r.agent.slice(0, 11)}…` : r.agent;
      const timing = batch.timings.get(i);
      const agentElapsed = timing
        ? fmtDuration((timing.end ?? Date.now()) - timing.start)
        : r.exitCode === -1
          ? fmtDuration(Date.now() - batch.startTime)
          : "";
      const tokenStr = r.usage.input ? `↑${formatTokens(r.usage.input)}` : "";
      const meta = [tokenStr, agentElapsed, r.usage.turns ? `${r.usage.turns}t` : ""]
        .filter(Boolean)
        .join(" ");
      const label = `${icon} ${name}${meta ? dim(` ${meta}`) : ""}`;
      return i === batch.selectedIndex
        ? c(`[${label}]`, CYAN)
        : `${dim(label)}`;
    });
    lines.push(" " + tabs.join(c("  ·  ", COMMENT)));
    lines.push(DIVIDER);

    // ── react 内容（当前选中 agent）──
    const result = batch.results[batch.selectedIndex];
    const contentLines: string[] = [];

    if (result) {
      const items = getDisplayItems(result.messages);
      if (items.length === 0) {
        contentLines.push(dim(result.exitCode === -1 ? "  (running…)" : "  (no output)"));
      } else {
        for (const item of items) {
          if (item.type === "toolCall") {
            contentLines.push(
              "  " + c("→ ", COMMENT) + formatToolCall(item.name, item.args, themeFg),
            );
          } else {
            for (const line of item.text.split("\n")) {
              contentLines.push(`  ${line}`);
            }
          }
        }
      }
      // 失败时附加 stderr（最多 5 行）
      if (isFailedResult(result) && result.stderr) {
        const errLines = result.stderr.split("\n").filter(Boolean).slice(-5);
        if (errLines.length) {
          contentLines.push(DIVIDER);
          for (const line of errLines) contentLines.push(`  ${c(line, PINK)}`);
        }
      }
    }

    this.contentLength = contentLines.length;
    const maxOffset = Math.max(0, this.contentLength - this.renderHeight);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    // 滚动视口 + 空行填满固定高度，防止 overlay 尺寸抖动
    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + this.renderHeight);
    while (visible.length < this.renderHeight) visible.push("");
    lines.push(...visible);

    // ── 底部帮助条 ──
    lines.push(DIVIDER);
    const scrollInfo =
      this.contentLength > this.renderHeight
        ? c(
            ` ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.renderHeight, this.contentLength)}/${this.contentLength}`,
            COMMENT,
          )
        : "";
    lines.push(
      dim("← → 切换") +
        c("  ·  ", COMMENT) +
        dim("↑↓ / PgUp/Dn 滚动") +
        c("  ·  ", COMMENT) +
        dim("Esc / Ctrl+G 退出") +
        scrollInfo,
    );

    return lines;
  }
}

/** openDetailOverlay 打开全屏 sub-agent react 详情 overlay */
export async function openDetailOverlay(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui" || !isBatchActive()) return;
  await ctx.ui.custom(
    (tui, _theme, _kb, done) => {
      const comp = new DetailOverlayComponent(tui, done);
      return Object.assign(comp, { dispose: () => comp.dispose() });
    },
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        maxHeight: "88%",
        anchor: "center",
      },
    },
  );
}
