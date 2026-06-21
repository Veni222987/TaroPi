import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, relative, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

// ── 配置类型 ──────────────────────────────────────────────

interface PermissionsConfig {
  read: {
    /** 默认允许所有读操作 */
    allowAll: boolean;
    /** 禁止读取的 glob 列表 */
    deny: string[];
  };
  write: {
    /** cwd 内默认允许写入 */
    allowCwd: boolean;
    /** 外部写入弹窗确认 */
    externalConfirm: boolean;
    /** 即使在 cwd 内也禁止写入的路径 */
    cwdDeny: string[];
  };
  bash: {
    /** cwd 内默认允许 */
    allowCwd: boolean;
    /** 外部操作弹窗确认 */
    externalConfirm: boolean;
  };
}

// ── 默认配置 ──────────────────────────────────────────────

const DEFAULT_CONFIG: PermissionsConfig = {
  read: {
    allowAll: true,
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
    ],
  },
  write: {
    allowCwd: true,
    externalConfirm: true,
    cwdDeny: [".git/**"],
  },
  bash: {
    allowCwd: true,
    externalConfirm: true,
  },
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
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return deepMerge(DEFAULT_CONFIG, raw);
    }
  } catch {
    // 配置损坏，降级到默认
  }
  // 首次写入默认配置
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  } catch {
    // 写入失败，静默降级
  }
  return DEFAULT_CONFIG;
}

// ── 路径匹配 ──────────────────────────────────────────────

/** 将路径统一为正斜杠格式 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 简单 glob 匹配：只支持 ** 和 * 通配符 */
function matchGlob(input: string, pattern: string): boolean {
  const s = normalizePath(input);
  const p = normalizePath(pattern);

  // ** 匹配任意中间路径
  if (p.includes("**")) {
    const idx = p.indexOf("**");
    const prefix = p.slice(0, idx);
    const suffix = p.slice(idx + 2); // 去掉 **
    if (prefix === "") {
      // **/xxx 模式：匹配任何以 /xxx 结尾的路径
      return s.endsWith(suffix) || s.includes(suffix + "/") || s === suffix.slice(1);
    } else if (suffix === "") {
      // xxx/** 模式：匹配以 xxx/ 开头的路径
      return s.startsWith(prefix) || s === prefix;
    } else {
      // xxx/**/yyy 模式
      return s.startsWith(prefix) && s.endsWith(suffix) && s.length >= prefix.length + suffix.length;
    }
  }

  // 仅文件名匹配（无 /）
  if (!p.includes("/")) {
    return matchWildcard(basename(s), p);
  }

  // 精确后缀匹配
  return s.endsWith("/" + p) || s === p;
}

/** 通配符匹配（仅支持 *） */
function matchWildcard(name: string, wildcard: string): boolean {
  const regex = new RegExp(
    "^" + wildcard.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  );
  return regex.test(name);
}

function isPathDenied(absPath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(absPath, p));
}

/** 检查路径是否在 cwd 内 */
function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(cwd, absPath);
  return !rel.startsWith("..") && !resolve(rel).startsWith("..");
}

// ── 从命令字符串提取可能的文件路径 ────────────────────────

function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  // 匹配绝对路径 /xxx/yyy
  const absPattern = /(?:^|\s)(\/[^\s;|&<>$`'"]+)/g;
  let m;
  while ((m = absPattern.exec(command)) !== null) {
    paths.push(m[1]);
  }
  // 匹配重定向写入 > /path 和 >> /path
  const redirectPattern = /[12]?>>?\s*(\/[^\s;|&]+)/g;
  while ((m = redirectPattern.exec(command)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

// ── 扩展主体 ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  pi.on("tool_call", async (event, ctx) => {
    // ── read 工具 ──
    if (isToolCallEventType("read", event)) {
      const absPath = resolve(ctx.cwd, event.input.path);

      // 检查 deny 列表
      if (isPathDenied(absPath, config.read.deny)) {
        ctx.ui.notify(`🔒 禁止读取敏感文件: ${event.input.path}`, "error");
        return { block: true, reason: `权限管控: 禁止读取 ${event.input.path}` };
      }

      // 默认允许
      return;
    }

    // ── write 工具 ──
    if (isToolCallEventType("write", event)) {
      const absPath = resolve(ctx.cwd, event.input.path);
      const insideCwd = isInsideCwd(absPath, ctx.cwd);

      // cwdDeny 检查（即使在 cwd 内也禁止）
      if (insideCwd && isPathDenied(absPath, config.write.cwdDeny)) {
        ctx.ui.notify(`🔒 禁止写入受保护路径: ${event.input.path}`, "error");
        return { block: true, reason: `权限管控: 禁止写入 ${event.input.path}` };
      }

      // cwd 内且 allowCwd → 放行
      if (insideCwd && config.write.allowCwd) {
        return;
      }

      // 外部路径 → 确认
      if (!insideCwd && config.write.externalConfirm) {
        const ok = await ctx.ui.confirm(
          "⚠️ 外部文件写入",
          `Agent 尝试写入 cwd 外部的文件:\n\n  ${absPath}\n\n允许此操作？`
        );
        if (!ok) {
          return { block: true, reason: "用户拒绝外部写入" };
        }
      }

      return;
    }

    // ── edit 工具 ──
    if (isToolCallEventType("edit", event)) {
      const absPath = resolve(ctx.cwd, event.input.path);
      const insideCwd = isInsideCwd(absPath, ctx.cwd);

      // cwdDeny 检查
      if (insideCwd && isPathDenied(absPath, config.write.cwdDeny)) {
        ctx.ui.notify(`🔒 禁止编辑受保护路径: ${event.input.path}`, "error");
        return { block: true, reason: `权限管控: 禁止编辑 ${event.input.path}` };
      }

      // cwd 内且 allowCwd → 放行
      if (insideCwd && config.write.allowCwd) {
        return;
      }

      // 外部路径 → 确认
      if (!insideCwd && config.write.externalConfirm) {
        const ok = await ctx.ui.confirm(
          "⚠️ 外部文件编辑",
          `Agent 尝试编辑 cwd 外部的文件:\n\n  ${absPath}\n\n允许此操作？`
        );
        if (!ok) {
          return { block: true, reason: "用户拒绝外部编辑" };
        }
      }

      return;
    }

    // ── bash 工具 ──
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;

      // 提取命令中的绝对路径
      const externalPaths = extractPathsFromCommand(command);

      if (externalPaths.length > 0 || !isSafeBashCommand(command, ctx.cwd)) {
        if (config.bash.externalConfirm) {
          const ok = await ctx.ui.confirm(
            "⚠️ Bash 命令确认",
            `Agent 执行命令:\n\n  ${command.slice(0, 200)}${command.length > 200 ? "..." : ""}\n\n可能涉及 cwd 外部路径，允许执行？`
          );
          if (!ok) {
            return { block: true, reason: "用户拒绝 bash 命令" };
          }
        }
      }

      return;
    }
  });
}

/** 简单的 bash 安全检查 */
function isSafeBashCommand(command: string, cwd: string): boolean {
  // 提取命令中的路径
  const paths = extractPathsFromCommand(command);

  // 如果没有外部绝对路径，认为安全
  if (paths.length === 0) return true;

  // 所有路径都在 cwd 内 → 安全
  return paths.every((p) => {
    const absPath = resolve(p);
    return isInsideCwd(absPath, cwd);
  });
}
