import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, relative, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// ── 配置类型 ──────────────────────────────────────────────

type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

/**
 * 统一 deny 规则：
 * - pattern：路径 glob（文件操作）或命令前缀/通配符（bash）
 * - reason：被拦截时原文透传给 AI 的引导文字，告诉它应该怎么做
 * - tool：适用的工具；省略时对所有文件操作（read/write/edit/grep/find/ls）生效，
 *         bash 命令规则必须显式指定 tool: "bash"
 */
interface DenyRule {
  pattern: string;
  reason?: string;
  tool?: ToolName | ToolName[];
}

/** deny 列表支持纯 glob/命令字符串或带元数据的对象，两种形式可混用 */
type DenyEntry = string | DenyRule;

interface PermissionsConfig {
  /** cwd 外的写/编辑操作弹窗确认 */
  externalWriteConfirm: boolean;
  /** 统一 deny 规则列表 */
  deny: DenyEntry[];
}

// ── 默认配置 ──────────────────────────────────────────────

const DEFAULT_CONFIG: PermissionsConfig = {
  externalWriteConfirm: true,
  deny: [
    "**/.bashrc",
    "**/.zshrc",
    "**/.bash_history",
    "**/.zsh_history",
    "**/.ssh/**",
    "**/.aws/**",
    "**/.env",
    "**/.env.*",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/id_ecdsa*",
    "**/.gnupg/**",
    // .git/** 仅限写/编辑，读取允许（如 git log 内部访问）
    { tool: ["write", "edit"], pattern: ".git/**" },
    // 禁止直接删除文件，改为移入回收站
    { tool: "bash", pattern: "rm *", reason: "禁止使用 rm 删除文件。请将文件移动到当前工作目录的 .trash 文件夹下（mkdir -p .trash && mv <target> .trash/）。" },
  ],
};

// ── 配置加载 ──────────────────────────────────────────────

const CONFIG_PATH = resolve(homedir(), ".pi", "agent", "permissions.json");

function deepMerge<T extends Record<string, any>>(base: T, overrides: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const v = overrides[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      (result as any)[key] = deepMerge((base as any)[key], v);
    } else {
      (result as any)[key] = v;
    }
  }
  return result;
}

function loadConfig(): PermissionsConfig {
  let merged = DEFAULT_CONFIG;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      merged = deepMerge(DEFAULT_CONFIG, raw);
    }
  } catch {
    // 配置损坏，降级到默认
  }
  // 始终写回，确保新增默认规则自动注入磁盘配置
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // 写入失败，静默降级
  }
  return merged;
}

// ── 规则匹配 ──────────────────────────────────────────────

function normalizeDenyEntry(entry: DenyEntry): DenyRule {
  return typeof entry === "string" ? { pattern: entry } : entry;
}

function ruleAppliesToTool(rule: DenyRule, tool: ToolName): boolean {
  if (!rule.tool) return tool !== "bash";
  return Array.isArray(rule.tool) ? rule.tool.includes(tool) : rule.tool === tool;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i++;
    } else {
      regex += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp("^" + regex + "$");
}

function matchGlob(input: string, pattern: string): boolean {
  return globToRegex(normalizePath(pattern)).test(normalizePath(input));
}

function matchCommandPattern(command: string, pattern: string): boolean {
  const cmd = command.trim();
  const pat = pattern.trim();
  if (pat.includes("*")) {
    const body = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("(?:^|[;&|]\\s*)" + body).test(cmd);
  }
  return cmd === pat || cmd.startsWith(pat + " ") || cmd.startsWith(pat + "\t");
}

function findDeniedPath(absPath: string, tool: Exclude<ToolName, "bash">, entries: DenyEntry[]): Required<Pick<DenyRule, "pattern" | "reason">> | null {
  for (const entry of entries) {
    const rule = normalizeDenyEntry(entry);
    if (!ruleAppliesToTool(rule, tool)) continue;
    if (matchGlob(absPath, rule.pattern)) {
      return { pattern: rule.pattern, reason: rule.reason ?? `权限管控: 禁止访问 ${rule.pattern}` };
    }
  }
  return null;
}

function findDeniedCommand(command: string, entries: DenyEntry[]): Required<Pick<DenyRule, "pattern" | "reason">> | null {
  for (const entry of entries) {
    const rule = normalizeDenyEntry(entry);
    if (!ruleAppliesToTool(rule, "bash")) continue;
    if (matchCommandPattern(command, rule.pattern)) {
      return { pattern: rule.pattern, reason: rule.reason ?? `权限管控: 禁止执行 ${rule.pattern}` };
    }
  }
  return null;
}

function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(cwd, absPath);
  return !rel.startsWith("..") && !resolve(rel).startsWith("..");
}

function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  const absPattern = /(?:^|\s)(\/[^\s;|&<>$`'"]+)/g;
  let m;
  while ((m = absPattern.exec(command)) !== null) paths.push(m[1]);
  const redirectPattern = /[12]?>>?\s*(\/[^\s;|&]+)/g;
  while ((m = redirectPattern.exec(command)) !== null) paths.push(m[1]);
  return paths;
}

// ── 扩展主体 ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("read", event)) {
      const rule = findDeniedPath(resolve(ctx.cwd, event.input.path), "read", config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止读取敏感文件: ${event.input.path}`, "error");
        return { block: true, reason: rule.reason };
      }
      return;
    }

    if (isToolCallEventType("grep", event)) {
      const inputPath = event.input.path ?? ".";
      const rule = findDeniedPath(resolve(ctx.cwd, inputPath), "grep", config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止搜索受保护路径: ${inputPath}`, "error");
        return { block: true, reason: rule.reason };
      }
      return;
    }

    if (isToolCallEventType("find", event)) {
      const inputPath = event.input.path ?? ".";
      const rule = findDeniedPath(resolve(ctx.cwd, inputPath), "find", config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止遍历受保护路径: ${inputPath}`, "error");
        return { block: true, reason: rule.reason };
      }
      return;
    }

    if (isToolCallEventType("ls", event)) {
      const inputPath = event.input.path ?? ".";
      const rule = findDeniedPath(resolve(ctx.cwd, inputPath), "ls", config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止列举受保护路径: ${inputPath}`, "error");
        return { block: true, reason: rule.reason };
      }
      return;
    }

    if (isToolCallEventType("write", event)) {
      const absPath = resolve(ctx.cwd, event.input.path);
      const rule = findDeniedPath(absPath, "write", config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止写入受保护路径: ${event.input.path}`, "error");
        return { block: true, reason: rule.reason };
      }
      if (!isInsideCwd(absPath, ctx.cwd) && config.externalWriteConfirm) {
        const ok = await ctx.ui.confirm("⚠️ 外部文件写入", `Agent 尝试写入 cwd 外部的文件:\n\n  ${absPath}\n\n允许此操作？`);
        if (!ok) return { block: true, reason: "用户拒绝外部写入" };
      }
      return;
    }

    if (isToolCallEventType("edit", event)) {
      const absPath = resolve(ctx.cwd, event.input.path);
      const rule = findDeniedPath(absPath, "edit", config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止编辑受保护路径: ${event.input.path}`, "error");
        return { block: true, reason: rule.reason };
      }
      if (!isInsideCwd(absPath, ctx.cwd) && config.externalWriteConfirm) {
        const ok = await ctx.ui.confirm("⚠️ 外部文件编辑", `Agent 尝试编辑 cwd 外部的文件:\n\n  ${absPath}\n\n允许此操作？`);
        if (!ok) return { block: true, reason: "用户拒绝外部编辑" };
      }
      return;
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      const rule = findDeniedCommand(command, config.deny);
      if (rule) {
        ctx.ui.notify(`🔒 禁止执行命令: ${command.slice(0, 60)}`, "error");
        return { block: true, reason: rule.reason };
      }
      const externalPaths = extractPathsFromCommand(command).filter((p) => !isInsideCwd(resolve(p), ctx.cwd));
      if (externalPaths.length > 0 && config.externalWriteConfirm) {
        const ok = await ctx.ui.confirm("⚠️ Bash 命令确认", `Agent 执行命令:\n\n  ${command.slice(0, 200)}${command.length > 200 ? "..." : ""}\n\n可能涉及 cwd 外部路径，允许执行？`);
        if (!ok) return { block: true, reason: "用户拒绝 bash 命令" };
      }
      return;
    }
  });
}
