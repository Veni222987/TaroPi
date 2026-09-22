/**
 * HUD 插件：提供赛博朋克风格的常驻基础状态看板和跨扩展子版块宿主。
 * 外部包通过 taropi-hud/api 的 createHudClient 注册同时具有刷新与文本渲染能力的版块。
 *
 * 移植自 pi-shannon-statusline（https://github.com/RealAlexandreAI/pi-shannon-statusline）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  rgb, c, dim,
  FG, COMMENT, PINK, GREEN, ORANGE, CYAN, PURPLE, YELLOW, BLUE,
  R, D, SEP, DIVIDER, hudTheme,
} from "./theme.ts";
import { HUD_EVENTS, HUD_PROTOCOL_VERSION, type HudPanelProvider, type HudRefreshRequest } from "./protocol.ts";
import { HudPanelRegistry } from "./registry.ts";
import { AgentSessionPresenceStore, groupAgentDirectories } from "./session-presence.ts";

const execFileAsync = promisify(execFile);
const panels = new HudPanelRegistry();
const HUD_HOST_SLOT = Symbol.for("taropi-hud-host");
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

interface AskUserBlockedEvent {
  active?: unknown;
}

interface GitStatus {
  branch: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

interface UsageTotals {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

let sessionStartTime = 0;
let turnIndex = 0;
let modelProvider = "";
let modelId = "";
let cwd = "";
let agentRunActive = false;
let waitingForUser = false;
let presence: AgentSessionPresenceStore | undefined;
let cumInputTokens = 0;
let cumCacheReadTokens = 0;
let cumCacheWriteTokens = 0;
let latestCtx: ExtensionContext | undefined;
let hudRenderSuspended = false;
let pendingHudResume: ReturnType<typeof setTimeout> | undefined;

const I_MODEL = "λ";
const I_PATH = "⌘";
const I_BRANCH = "⎇";
const I_CLOCK = "✦";
const I_CTX = "⊡";
const I_TOK = "Σ";
const I_HIT = "◎";

function abbreviateSegment(segment: string): string {
  if (segment.length <= 1) return segment;
  const extra = segment.match(/[-.](.)/);
  return extra ? `${segment[0]}${extra[0]}` : segment[0];
}

function truncateTailSegment(segment: string, maxLen: number): string {
  if (segment.length <= maxLen) return segment;
  if (maxLen <= 1) return "…";
  const extStart = segment.lastIndexOf(".");
  const hasExt = extStart > 0 && extStart < segment.length - 1;
  if (!hasExt) return `…${segment.slice(-(maxLen - 1))}`;
  const ext = segment.slice(extStart);
  const base = segment.slice(0, extStart);
  const budget = maxLen - ext.length - 1;
  if (budget <= 0) return `…${ext.slice(-(maxLen - 1))}`;
  return `…${base.slice(-budget)}${ext}`;
}

// shortenDisplayPath 将绝对路径转换为适合 HUD 显示的缩写路径。
export function shortenDisplayPath(fullPath: string, home: string, maxLen: number): string {
  if (!fullPath) return "";
  let display = fullPath;
  if (home && fullPath === home) return "~";
  if (home && fullPath.startsWith(home + "/")) display = "~" + fullPath.slice(home.length);

  const prefix = display.startsWith("~") ? "~" : display.startsWith("/") ? "/" : "";
  const rawParts = display.split("/").filter(Boolean);
  const parts = prefix === "~" ? rawParts.slice(1) : rawParts;
  if (parts.length <= 1) return display;

  const tail = parts.slice(-1);
  const head = parts.slice(0, -1).map(abbreviateSegment);
  let shortened = [...head, ...tail].join("/");
  if (prefix) shortened = prefix + "/" + shortened;
  if (shortened.length <= maxLen) return shortened;

  const ellipsis = prefix + "/…/" + tail.join("/");
  if (ellipsis.length <= maxLen) return ellipsis;
  const budget = Math.max(1, maxLen - (prefix ? prefix.length + 4 : 3));
  return `${prefix ? prefix + "/" : ""}…/${truncateTailSegment(tail[0]!, budget)}`;
}

function ctxBar(percent: number, width: number): string {
  const safePercent = Math.min(100, Math.max(0, percent));
  const filled = Math.round((safePercent / 100) * width);
  const empty = width - filled;
  let start: [number, number, number];
  let end: [number, number, number];
  if (safePercent >= 85) {
    start = [90, 0, 48];
    end = [255, 0, 144];
  } else if (safePercent >= 70) {
    start = [122, 21, 0];
    end = [255, 107, 0];
  } else {
    start = [0, 51, 0];
    end = [57, 255, 20];
  }

  const cells: string[] = [];
  for (let index = 0; index < filled; index++) {
    const ratio = filled > 1 ? index / (filled - 1) : 1;
    cells.push(`${rgb(Math.round(start[0] + (end[0] - start[0]) * ratio), Math.round(start[1] + (end[1] - start[1]) * ratio), Math.round(start[2] + (end[2] - start[2]) * ratio))}█`);
  }
  return `${cells.join("")}${D}${"░".repeat(empty)}${R}`;
}

function ctxPctColor(percent: number): string {
  if (percent >= 85) return rgb(255, 0, 144);
  if (percent >= 70) return rgb(255, 107, 0);
  return rgb(57, 255, 20);
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function fmtDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

async function getGit(directory: string): Promise<GitStatus | null> {
  if (!directory) return null;
  try {
    const { stdout: branchOutput } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: directory,
      timeout: 1500,
      encoding: "utf8",
    });
    const branch = branchOutput.trim();
    if (!branch) return null;

    let isDirty = false;
    let modified = 0;
    let added = 0;
    let deleted = 0;
    let untracked = 0;
    try {
      const { stdout: statusOutput } = await execFileAsync("git", ["--no-optional-locks", "status", "--porcelain"], {
        cwd: directory,
        timeout: 1500,
        encoding: "utf8",
      });
      const statusLines = statusOutput.trim().split("\n").filter(Boolean);
      isDirty = statusLines.length > 0;
      for (const line of statusLines) {
        if (line.startsWith("??")) untracked++;
        else if (line[0] === "A") added++;
        else if (line[0] === "D" || line[1] === "D") deleted++;
        else if (line[0] === "M" || line[1] === "M" || line[0] === "R" || line[0] === "C") modified++;
      }
    } catch {
      // Git 状态细节不可用时仍显示分支。
    }

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revisionOutput } = await execFileAsync("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], {
        cwd: directory,
        timeout: 1500,
        encoding: "utf8",
      });
      const parts = revisionOutput.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = Number.parseInt(parts[0]!, 10) || 0;
        ahead = Number.parseInt(parts[1]!, 10) || 0;
      }
    } catch {
      // 没有 upstream 时不显示同步状态。
    }
    return { branch, isDirty, ahead, behind, modified, added, deleted, untracked };
  } catch {
    return null;
  }
}

async function buildHud(ctx: ExtensionContext): Promise<string[]> {
  const lines: string[] = [DIVIDER];
  const parts: string[] = [];
  const home = homedir();

  if (cwd) parts.push(`${c(I_PATH, ORANGE)} ${c(shortenDisplayPath(cwd, home, 30), ORANGE)}`);
  const git = await getGit(cwd);
  if (git) {
    let gitText = `${c(I_BRANCH, CYAN)} ${c(`${git.branch}${git.isDirty ? "*" : ""}`, CYAN)}`;
    const details: string[] = [];
    if (git.ahead > 0) details.push(c(`↑${git.ahead}`, GREEN));
    if (git.behind > 0) details.push(c(`↓${git.behind}`, PINK));
    if (git.modified > 0) details.push(c(`!${git.modified}`, PINK));
    if (git.added > 0) details.push(c(`+${git.added}`, GREEN));
    if (git.deleted > 0) details.push(c(`✘${git.deleted}`, PINK));
    if (git.untracked > 0) details.push(c(`?${git.untracked}`, COMMENT));
    if (details.length > 0) gitText += ` ${details.join(" ")}`;
    parts.push(gitText);
  }
  if (sessionStartTime > 0) {
    if (turnIndex > 0) parts.push(`${c("↺ loop", PURPLE)} ${c(`×${turnIndex}`, FG)}`);
    parts.push(`${c(I_CLOCK, COMMENT)} ${c(fmtDuration(Date.now() - sessionStartTime), COMMENT)}`);
  }
  parts.push(formatModel());

  try {
    const usage = ctx.getContextUsage();
    if (usage) {
      const percent = usage.percent ?? 0;
      const contextWindow = usage.contextWindow ?? 0;
      const windowLabel = contextWindow >= 1_000_000
        ? `${(contextWindow / 1_000_000).toFixed(1)}M`
        : contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}k` : "";
      let contextText = `${c(I_CTX, CYAN)} ${ctxBar(percent, 10)} ${c(`${percent.toFixed(1)}%`, ctxPctColor(percent))}`;
      if (windowLabel) contextText += ` ${dim(`(${windowLabel})`)}`;
      parts.push(contextText);
      const cacheTotal = cumInputTokens + cumCacheReadTokens + cumCacheWriteTokens;
      const cacheHitRate = cacheTotal > 0 ? (cumCacheReadTokens / cacheTotal) * 100 : 0;
      parts.push(`${c(I_TOK, CYAN)} ${c(fmtTokens(usage.tokens ?? 0), FG)} ${c(I_HIT, PURPLE)} ${c(`${cacheHitRate.toFixed(0)}%`, FG)}`);
    }
  } catch {
    // 上下文用量暂不可用时保留其他基础信息。
  }

  lines.push(parts.join(` ${SEP} `));
  const directories = groupAgentDirectories(presence?.getRecords() ?? []);
  lines.push(formatAgentStatusLine("idle", directories.idle));
  lines.push(formatAgentStatusLine("working", directories.working));

  for (const panel of panels.get()) {
    try {
      const panelLines = panel.provider.render(panel.state, hudTheme, 67);
      if (panelLines.length > 0) {
        lines.push(DIVIDER);
        lines.push(...panelLines);
      }
    } catch {
      lines.push(DIVIDER);
      lines.push(`${c("!", PINK)} ${c(panel.provider.key, PINK)} ${dim("渲染失败")}`);
    }
  }
  return lines;
}

function formatModel(): string {
  if (modelProvider && modelId) return `${c(I_MODEL, BLUE)} ${c(modelProvider, COMMENT)}${dim("/")}${c(modelId, BLUE)}`;
  if (modelId) return `${c(I_MODEL, BLUE)} ${c(modelId, BLUE)}`;
  if (modelProvider) return `${c(I_MODEL, BLUE)} ${c(modelProvider, BLUE)}`;
  return `${c(I_MODEL, BLUE)} ${c("pi", BLUE)}`;
}

function formatAgentStatusLine(status: "idle" | "working", directories: readonly string[]): string {
  const color = status === "idle" ? GREEN : YELLOW;
  const label = `${status} agent:`;
  if (directories.length === 0) return `${c(label, color)} ${dim("—")}`;
  const paths = directories.map((directory) => c(shortenDisplayPath(directory, homedir(), 60), FG));
  return `${c(label, color)} ${paths.join(`${dim(", ")} `)}`;
}

function clearHud(ctx?: ExtensionContext): void {
  const target = ctx ?? latestCtx;
  if (target) target.ui.setWidget("taropi-hud", undefined, { placement: "belowEditor" });
}

function syncPresence(ctx?: ExtensionContext): void {
  const target = ctx ?? latestCtx;
  if (!target || target.mode !== "tui") return;
  const status = waitingForUser || (!agentRunActive && target.isIdle()) ? "idle" : "working";
  presence?.setStatus(status);
}

function suspendHudRendering(ctx?: ExtensionContext): void {
  hudRenderSuspended = true;
  if (pendingHudResume) clearTimeout(pendingHudResume);
  pendingHudResume = undefined;
  clearHud(ctx);
}

function scheduleHudResume(): void {
  if (!hudRenderSuspended || pendingHudResume) return;
  pendingHudResume = setTimeout(() => {
    pendingHudResume = undefined;
    hudRenderSuspended = false;
    void refreshHud();
  }, 0);
  pendingHudResume.unref?.();
}

async function refreshHud(ctx?: ExtensionContext): Promise<void> {
  if (hudRenderSuspended) return;
  const target = ctx ?? latestCtx;
  if (!target || target.mode !== "tui") return;
  try {
    const lines = await buildHud(target);
    if (!hudRenderSuspended) target.ui.setWidget("taropi-hud", lines, { placement: "belowEditor" });
  } catch {
    // HUD 基础信息采集失败时保留上一次终端内容。
  }
}

async function refreshPanels(request: HudRefreshRequest, ctx?: ExtensionContext): Promise<string[]> {
  const target = ctx ?? latestCtx;
  const registered = panels.get(request.key);
  if (!target) return registered.map((panel) => panel.provider.key);
  const results = await panels.refresh(request.key, target, request.reason);
  await refreshHud(target);
  return results.flatMap((result, index) => result.status === "rejected" ? [registered[index]?.provider.key ?? "unknown"] : []);
}

function updateUsageTotals(message: unknown): void {
  const usage = getUsageTotals(message);
  if (!usage) return;
  cumInputTokens += usage.input ?? 0;
  cumCacheReadTokens += usage.cacheRead ?? 0;
  cumCacheWriteTokens += usage.cacheWrite ?? 0;
}

function getUsageTotals(message: unknown): UsageTotals | undefined {
  if (typeof message !== "object" || message === null || !("usage" in message)) return undefined;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const input = typeof usageRecord.input === "number" ? usageRecord.input : undefined;
  const cacheRead = typeof usageRecord.cacheRead === "number" ? usageRecord.cacheRead : undefined;
  const cacheWrite = typeof usageRecord.cacheWrite === "number" ? usageRecord.cacheWrite : undefined;
  return { input, cacheRead, cacheWrite };
}

// registerHud 注册 HUD 宿主、基础状态看板和跨扩展刷新协议。
export function registerHud(pi: ExtensionAPI): void {
  const hostFlags = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;
  if (hostFlags[HUD_HOST_SLOT]) return;
  hostFlags[HUD_HOST_SLOT] = true;

  pi.events.on(HUD_EVENTS.register, (value: unknown) => {
    const registration = value as { version?: unknown; provider?: unknown } | undefined;
    const provider = registration?.provider as Partial<HudPanelProvider> | undefined;
    if (registration?.version !== HUD_PROTOCOL_VERSION || !provider || typeof provider.key !== "string") return;
    if (typeof provider.refresh !== "function" || typeof provider.render !== "function") return;
    if (provider.timeoutMs !== undefined && (!Number.isFinite(provider.timeoutMs) || provider.timeoutMs <= 0)) return;
    panels.register(provider as HudPanelProvider);
    void refreshPanels({ key: provider.key, reason: "initial" });
  });
  pi.events.on(HUD_EVENTS.unregister, (value: unknown) => {
    const request = value as { key?: unknown; provider?: unknown } | undefined;
    if (typeof request?.key !== "string" || !request.provider) return;
    panels.unregister(request.key, request.provider as HudPanelProvider);
    void refreshHud();
  });
  pi.events.on(HUD_EVENTS.render, () => void refreshHud());
  pi.events.on(HUD_EVENTS.refresh, (value: unknown) => {
    const request = value as Partial<HudRefreshRequest> | undefined;
    if (!request || (request.key !== undefined && typeof request.key !== "string")) return;
    const normalized: HudRefreshRequest = {
      key: request.key,
      reason: request.reason === "initial" || request.reason === "command" ? request.reason : "external",
      requestId: request.requestId,
    };
    void refreshPanels(normalized).then((failedKeys) => {
      if (normalized.requestId) pi.events.emit(HUD_EVENTS.refreshResult, { requestId: normalized.requestId, failedKeys });
    });
  });

  pi.registerCommand("hud-fresh", {
    description: "并发刷新全部 HUD 子版块并统一显示结果",
    handler: async (_args, ctx) => {
      const failedKeys = await refreshPanels({ reason: "command" }, ctx);
      if (failedKeys.length > 0) ctx.ui.notify(`HUD 刷新完成，失败: ${failedKeys.join(", ")}`, "warning");
      else ctx.ui.notify("HUD 已刷新", "info");
    },
  });

  pi.events.on(ASK_USER_BLOCKED_EVENT, (value: unknown) => {
    const event = value as AskUserBlockedEvent | undefined;
    if (event?.active === true) {
      waitingForUser = true;
      syncPresence();
      suspendHudRendering();
    } else if (event?.active === false) {
      waitingForUser = false;
      syncPresence();
      scheduleHudResume();
    }
  });
  pi.events.emit(HUD_EVENTS.hostReady, { version: HUD_PROTOCOL_VERSION });

  pi.on("session_shutdown", (_event, ctx) => {
    panels.invalidate();
    latestCtx = undefined;
    const activePresence = presence;
    presence = undefined;
    void activePresence?.stop();
    if (pendingHudResume) clearTimeout(pendingHudResume);
    pendingHudResume = undefined;
    hudRenderSuspended = false;
    if (ctx.mode === "tui") clearHud(ctx);
    hostFlags[HUD_HOST_SLOT] = false;
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    hudRenderSuspended = false;
    if (pendingHudResume) clearTimeout(pendingHudResume);
    pendingHudResume = undefined;
    sessionStartTime = Date.now();
    turnIndex = 0;
    cwd = ctx.cwd;
    agentRunActive = false;
    waitingForUser = false;
    cumInputTokens = 0;
    cumCacheReadTokens = 0;
    cumCacheWriteTokens = 0;
    modelProvider = ctx.model?.provider ?? "";
    modelId = ctx.model?.id ?? "";
    if (ctx.mode === "tui") {
      const previousPresence = presence;
      presence = new AgentSessionPresenceStore({ onChange: () => void refreshHud() });
      void previousPresence?.stop();
      presence.start(ctx.sessionManager.getSessionId(), ctx.cwd, "idle");
      ctx.ui.setFooter(() => ({ invalidate() {}, render: () => [] }));
    }
    void refreshPanels({ reason: "initial" }, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    latestCtx = ctx;
    modelProvider = event.model?.provider ?? "";
    modelId = event.model?.id ?? "";
    void refreshHud(ctx);
  });
  pi.on("turn_start", (event, ctx) => {
    latestCtx = ctx;
    turnIndex = event.turnIndex;
    void refreshHud(ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    latestCtx = ctx;
    updateUsageTotals(event.message);
    void refreshHud(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
    agentRunActive = true;
    syncPresence(ctx);
    void refreshHud(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx;
    agentRunActive = false;
    syncPresence(ctx);
    void refreshHud(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    latestCtx = ctx;
    agentRunActive = true;
    syncPresence(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    latestCtx = ctx;
    agentRunActive = false;
    syncPresence(ctx);
    void refreshHud(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    latestCtx = ctx;
    agentRunActive = false;
    syncPresence(ctx);
    void refreshHud(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    latestCtx = ctx;
    waitingForUser = true;
    syncPresence(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    latestCtx = ctx;
    waitingForUser = false;
    syncPresence(ctx);
  });
}

export { createHudClient } from "./api.ts";
export type { HudClient, HudPanelHandle } from "./api.ts";
export type { HudPanelProvider, HudPanelState, HudRefreshContext, HudRefreshReason } from "./protocol.ts";
