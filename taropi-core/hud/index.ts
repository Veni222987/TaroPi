/**
 * HUD 插件 —— 赛博朋克风格的常驻状态面板，同时作为全局看板中心。
 * 其他插件可通过 hud/registry.ts 的 registerHudPanel / requestHudRefresh
 * 向 HUD 注册内容面板，实现统一的视觉入口。
 *
 * 移植自 pi-shannon-statusline（https://github.com/RealAlexandreAI/pi-shannon-statusline）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  rgb, c, dim,
  FG, COMMENT, PINK, GREEN, ORANGE, CYAN, PURPLE, YELLOW, BLUE,
  R, D, SEP, DIVIDER, hudTheme, fmtDuration,
} from "./theme.ts";
import { getHudPanels, setHudRefreshCallback } from "./registry.ts";

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

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

interface AgentRecord {
  status: "running" | "completed";
  startTime: number;
  endTime?: number;
}

interface ToolRecord {
  name: string;
  target: string | null;
  status: "running" | "completed" | "error";
  startTime: number;
  endTime?: number;
}

// ═══════════════════════════════════════════════════════════════
// 会话状态（模块级，跨事件共享）
// ═══════════════════════════════════════════════════════════════

let sessionStartTime = 0;
let turnIndex = 0;
let tools: ToolRecord[] = [];
let agents: AgentRecord[] = [];
let modelProvider = "";
let modelId = "";
let cwd = "";

// 会话累计 token 用量（来自每轮 turn_end 的 usage，用于计算缓存命中率）
let cumInputTokens = 0;
let cumCacheReadTokens = 0;
let cumCacheWriteTokens = 0;

// 缓存最新的 ctx，供 requestHudRefresh 触发时使用
let latestCtx: any = null;

// ═══════════════════════════════════════════════════════════════
// 图标（与 shannon-statusline 保持一致）
// ═══════════════════════════════════════════════════════════════

const I_MODEL = "λ";
const I_PATH = "⌘";
const I_BRANCH = "⎇";
const I_CLOCK = "✦";
const I_CTX = "⊡";
const I_TOK = "Σ";
const I_HIT = "◎";
const I_DONE = "✔";
const I_RUN = "↻";
const I_CLAUDE = "※";
const I_MCP = "⊕";
const I_SKILL = "★";

// ═══════════════════════════════════════════════════════════════
// Fish 风格路径缩写（移植自原版 shannon-statusline）
// ═══════════════════════════════════════════════════════════════

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

export function shortenDisplayPath(fullPath: string, home: string, maxLen: number): string {
  if (!fullPath) return "";
  let display = fullPath;
  if (home && fullPath === home) return "~";
  if (home && fullPath.startsWith(home + "/")) {
    display = "~" + fullPath.slice(home.length);
  }

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

// ═══════════════════════════════════════════════════════════════
// 上下文用量条
// ═══════════════════════════════════════════════════════════════

function ctxBar(percent: number, width: number): string {
  const safeP = Math.min(100, Math.max(0, percent));
  const filled = Math.round((safeP / 100) * width);
  const empty = width - filled;

  let r0: number, g0: number, b0: number;
  let r1: number, g1: number, b1: number;
  if (safeP >= 85) {
    [r0, g0, b0] = [90, 0, 48];
    [r1, g1, b1] = [255, 0, 144];
  } else if (safeP >= 70) {
    [r0, g0, b0] = [122, 21, 0];
    [r1, g1, b1] = [255, 107, 0];
  } else {
    [r0, g0, b0] = [0, 51, 0];
    [r1, g1, b1] = [57, 255, 20];
  }

  const cells: string[] = [];
  for (let i = 0; i < filled; i++) {
    const t = filled > 1 ? i / (filled - 1) : 1;
    cells.push(
      `${rgb(Math.round(r0 + (r1 - r0) * t), Math.round(g0 + (g1 - g0) * t), Math.round(b0 + (b1 - b0) * t))}█`,
    );
  }
  return `${cells.join("")}${D}${"░".repeat(empty)}${R}`;
}

function ctxPctColor(percent: number): string {
  if (percent >= 85) return rgb(255, 0, 144);
  if (percent >= 70) return rgb(255, 107, 0);
  return rgb(57, 255, 20);
}

// ═══════════════════════════════════════════════════════════════
// 工具白名单

// ═══════════════════════════════════════════════════════════════
// Git 状态
// ═══════════════════════════════════════════════════════════════

async function getGit(dir: string): Promise<GitStatus | null> {
  if (!dir) return null;
  try {
    const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      timeout: 1500,
      encoding: "utf8",
    });
    const branch = branchOut.trim();
    if (!branch) return null;

    let isDirty = false,
      modified = 0,
      added = 0,
      deleted = 0,
      untracked = 0;
    try {
      const { stdout: statusOut } = await execFileAsync("git", ["--no-optional-locks", "status", "--porcelain"], {
        cwd: dir,
        timeout: 1500,
        encoding: "utf8",
      });
      const lines = statusOut.trim().split("\n").filter(Boolean);
      isDirty = lines.length > 0;
      for (const line of lines) {
        if (line.startsWith("??")) untracked++;
        else if (line[0] === "A") added++;
        else if (line[0] === "D" || line[1] === "D") deleted++;
        else if (line[0] === "M" || line[1] === "M" || line[0] === "R" || line[0] === "C") modified++;
      }
    } catch {
      /* 忽略 */
    }

    let ahead = 0,
      behind = 0;
    try {
      const { stdout: revOut } = await execFileAsync(
        "git",
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        { cwd: dir, timeout: 1500, encoding: "utf8" },
      );
      const parts = revOut.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = parseInt(parts[0]!, 10) || 0;
        ahead = parseInt(parts[1]!, 10) || 0;
      }
    } catch {
      /* 没有 upstream */
    }

    return { branch, isDirty, ahead, behind, modified, added, deleted, untracked };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 配置计数
// ═══════════════════════════════════════════════════════════════

function countConfigs(dir: string) {
  let agentsMd = 0,
    mcps = 0,
    skills = 0,
    extensions = 0;
  const home = homedir();
  try {
    // 项目内的 AGENTS.md / CLAUDE.md
    if (existsSync(join(dir, "AGENTS.md"))) agentsMd++;
    if (existsSync(join(dir, "CLAUDE.md"))) agentsMd++;

    // 来自 pi 缓存的 MCP 数量
    try {
      const mcpCache = JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp-cache.json"), "utf8"));
      const servers = mcpCache?.servers;
      if (servers && typeof servers === "object") mcps = Object.keys(servers).length;
    } catch {
      /* 忽略 */
    }

    // 来自 pi skills 目录的技能数量
    const skillsDir = join(home, ".pi", "agent", "skills");
    if (existsSync(skillsDir)) {
      skills = readdirSync(skillsDir).filter((f) => !f.startsWith(".")).length;
    }

    // 来自 pi settings.json 的已安装扩展数量
    try {
      const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
      const packages: string[] = settings?.packages ?? [];
      extensions = packages.length;
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 忽略 */
  }
  return { agentsMd, mcps, skills, extensions };
}

// ═══════════════════════════════════════════════════════════════
// HUD 渲染
// ═══════════════════════════════════════════════════════════════

async function buildHud(ctx: any): Promise<string[]> {
  const lines: string[] = [];
  const dir = cwd;
  const sep = SEP;

  // ── 顶部分隔线（与候选命令区分）──
  lines.push(DIVIDER);

  // ── 第一行：项目路径 + Git + 会话时长 ──
  const parts1: string[] = [];
  if (dir) {
    const home = homedir();
    parts1.push(`${c(I_PATH, ORANGE)} ${c(shortenDisplayPath(dir, home, 30), ORANGE)}`);
  }

  const git = await getGit(dir);
  if (git) {
    const dirty = git.isDirty ? "*" : "";
    const branchColor = CYAN;
    let gitStr = `${c(I_BRANCH, branchColor)} ${c(`${git.branch}${dirty}`, branchColor)}`;
    const details: string[] = [];
    if (git.ahead > 0) details.push(c(`↑${git.ahead}`, GREEN));
    if (git.behind > 0) details.push(c(`↓${git.behind}`, PINK));
    if (git.modified > 0) details.push(c(`!${git.modified}`, PINK));
    if (git.added > 0) details.push(c(`+${git.added}`, GREEN));
    if (git.deleted > 0) details.push(c(`✘${git.deleted}`, PINK));
    if (git.untracked > 0) details.push(c(`?${git.untracked}`, COMMENT));
    if (details.length > 0) gitStr += ` ${details.join(" ")}`;
    parts1.push(gitStr);
  }

  if (sessionStartTime > 0) {
    if (turnIndex > 0) parts1.push(`${c(`↺ loop`, PURPLE)} ${c(`×${turnIndex}`, FG)}`);
    parts1.push(`${c(I_CLOCK, COMMENT)} ${c(fmtDuration(Date.now() - sessionStartTime), COMMENT)}`);
  }

  lines.push(parts1.join(` ${sep} `));

  // ── 第二行：模型(provider/id) + 上下文用量 + token 用量 ──
  const providerColor = COMMENT;
  let modelStr: string;
  if (modelProvider && modelId) {
    modelStr = `${c(I_MODEL, BLUE)} ${c(modelProvider, providerColor)}${dim("/")}${c(modelId, BLUE)}`;
  } else if (modelId) {
    modelStr = `${c(I_MODEL, BLUE)} ${c(modelId, BLUE)}`;
  } else if (modelProvider) {
    modelStr = `${c(I_MODEL, BLUE)} ${c(modelProvider, BLUE)}`;
  } else {
    modelStr = `${c(I_MODEL, BLUE)} ${c("pi", BLUE)}`;
  }

  let ctxStr = "";
  try {
    const usage = ctx.getContextUsage?.();
    if (usage) {
      const pct = usage.percent ?? 0;
      const bar = ctxBar(pct, 10);
      const win = usage.contextWindow ?? 0;
      const winLabel =
        win >= 1_000_000 ? `${(win / 1_000_000).toFixed(1)}M` : win >= 1000 ? `${Math.round(win / 1000)}k` : "";
      ctxStr = `${c(I_CTX, CYAN)} ${bar} ${c(`${pct.toFixed(1)}%`, ctxPctColor(pct))}`;
      if (winLabel) ctxStr += ` ${dim(`(${winLabel})`)}`;

      const totalTokens = usage.tokens ?? 0;
      const cacheTotal = cumInputTokens + cumCacheReadTokens + cumCacheWriteTokens;
      const cacheHitRate = cacheTotal > 0 ? (cumCacheReadTokens / cacheTotal) * 100 : 0;
      const tokStr =
        `${c(I_TOK, CYAN)} ${c(fmtTokens(totalTokens), FG)} ` +
        `${c(I_HIT, PURPLE)} ${c(`${cacheHitRate.toFixed(0)}%`, FG)}`;

      const line2 = `${modelStr} ${sep} ${ctxStr} ${sep} ${tokStr}`;
      lines.push(line2);
    } else {
      lines.push(modelStr);
    }
  } catch {
    lines.push(modelStr);
  }

  // ── 第三行：配置计数 ──
  const configs = countConfigs(dir);
  const cfgParts: string[] = [];
  if (configs.agentsMd > 0) cfgParts.push(`${c(I_CLAUDE, BLUE)} ${c(`×${configs.agentsMd}`, BLUE)} ${dim("AGENTS.md")}`);
  if (configs.mcps > 0) cfgParts.push(`${c(I_MCP, ORANGE)} ${c(`×${configs.mcps}`, ORANGE)} ${dim("MCPs")}`);
  if (configs.skills > 0) cfgParts.push(`${c(I_SKILL, PURPLE)} ${c(`×${configs.skills}`, PURPLE)} ${dim("skills")}`);
  if (cfgParts.length > 0) lines.push(cfgParts.join(` ${sep} `));

  // ── 分隔线 + 工具调用统计 ──
  const completed = tools.filter((t) => t.status === "completed" && TOOL_WHITELIST.has(t.name));
  const toolCounts = new Map<string, number>();
  for (const t of completed) toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1);

  const toolLineParts: string[] = [];
  for (const name of toolCounts.keys()) {
    const count = toolCounts.get(name) ?? 0;
    if (count > 0) toolLineParts.push(`${GREEN} ${c(name, FG)}${count > 1 ? ` ${c(`×${count}`, COMMENT)}` : ""}`);
  }

  // 右侧展示运行中的 sub-agent 数量
  const activeAgents = agents.filter((a) => a.status === "running").length;
  if (activeAgents > 0) {
    toolLineParts.push(`${c(I_RUN, PURPLE)} ${c("agent", PURPLE)} ${c(`×${activeAgents}`, PURPLE)}`);
  }

  if (toolLineParts.length > 0) {
    lines.push(DIVIDER);
    lines.push(toolLineParts.join(` ${sep} `));
  }

  // ── 运行中的工具 ──
  const running = tools.filter((t) => t.status === "running");
  for (const t of running.slice(-2)) {
    const elapsed = fmtDuration(Date.now() - t.startTime);
    const target = t.target ? `: ${shortenDisplayPath(t.target, homedir(), 22)}` : "";
    lines.push(`${c(I_RUN, YELLOW)} ${c(t.name, CYAN)}${target} ${c(`(${elapsed})`, COMMENT)}`);
  }

  // ── 插件注册的扩展面板 ──
  for (const panel of getHudPanels()) {
    const panelLines = panel.render(hudTheme);
    if (panelLines.length > 0) {
      lines.push(DIVIDER);
      lines.push(...panelLines);
    }
  }

  return lines;
}

// ═══════════════════════════════════════════════════════════════
// HUD 刷新
// ═══════════════════════════════════════════════════════════════

function refreshHud(ctx?: any) {
  const target = ctx ?? latestCtx;
  if (!target) return;
  buildHud(target)
    .then((lines) => {
      if (lines.length > 0) target.ui.setWidget("taropi-hud", lines, { placement: "belowEditor" });
    })
    .catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// 扩展入口
// ═══════════════════════════════════════════════════════════════

export function registerHud(pi: ExtensionAPI) {
  // 注册刷新回调，供其他插件通过 requestHudRefresh() 触发重渲染
  setHudRefreshCallback(() => refreshHud());

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    sessionStartTime = Date.now();
    turnIndex = 0;
    cwd = ctx.cwd;
    tools = [];
    cumInputTokens = 0;
    cumCacheReadTokens = 0;
    cumCacheWriteTokens = 0;
    if (ctx.model) {
      modelProvider = (ctx.model as any).provider ?? "";
      modelId = (ctx.model as any).id ?? "";
    }
    // 隐藏原生 footer，避免与 HUD 信息重复
    ctx.ui.setFooter(() => ({ invalidate() {}, render: () => [] }));
    refreshHud(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    latestCtx = ctx;
    if (event.model) {
      modelProvider = (event.model as any).provider ?? "";
      modelId = (event.model as any).id ?? "";
    }
    refreshHud(ctx);
  });

  pi.on("turn_start", (event, ctx) => {
    latestCtx = ctx;
    turnIndex = event.turnIndex ?? turnIndex + 1;
    refreshHud(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    latestCtx = ctx;
    const tool: ToolRecord = { name: event.toolName, target: null, status: "running", startTime: Date.now() };
    if (event.input && typeof event.input === "object") {
      const inp = event.input as Record<string, unknown>;
      if (typeof inp.path === "string") tool.target = inp.path;
      else if (typeof inp.filePath === "string") tool.target = inp.filePath;
    }
    tools.push(tool);
    // 长会话下限制上限为 500，防止无限增长
    if (tools.length > 500) tools = tools.slice(-400);
    refreshHud(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    latestCtx = ctx;
    for (let i = tools.length - 1; i >= 0; i--) {
      if (tools[i]!.name === event.toolName && tools[i]!.status === "running") {
        tools[i]!.status = event.isError ? "error" : "completed";
        tools[i]!.endTime = Date.now();
        break;
      }
    }
    refreshHud(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    latestCtx = ctx;
    // 累计本轮的 token 用量（仅当 message 为带 usage 的 assistant 消息时）
    const msg = event.message as any;
    const usage = msg?.usage;
    if (usage) {
      cumInputTokens += usage.input ?? 0;
      cumCacheReadTokens += usage.cacheRead ?? 0;
      cumCacheWriteTokens += usage.cacheWrite ?? 0;
    }
    refreshHud(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
    agents.push({ status: "running", startTime: Date.now() });
    refreshHud(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    latestCtx = ctx;
    // 将最早开始的运行中 agent 标记为完成
    const running = agents.find((a) => a.status === "running");
    if (running) {
      running.status = "completed";
      running.endTime = Date.now();
    }
    refreshHud(ctx);
  });
}
