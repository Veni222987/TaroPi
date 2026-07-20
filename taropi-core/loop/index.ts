/**
 * /loop —— crontab 驱动的定时循环
 *
 * 每一轮都是 crontab 拉起的全新 `pi -p --no-session` 进程/session，跟当前交互式
 * 会话完全隔离。agent 的 model/tools/systemPrompt 在 /loop create 时解析一次，
 * 烤进 crontab 命令行；只有任务文本（task.md）在每轮触发时用 `$(cat task.md)`
 * 现读现填，做到随时可编辑、下一轮自动生效。
 *
 * 落盘：.pi/taropi/loop/<name>/{config.json, task.md, system-prompt.md, runs/*.log}
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveLoopAgent, resolveModelName } from "./agent-resolve.ts";
import {
  buildLoopCommand,
  listLoops,
  listRuns,
  loopExists,
  parseInterval,
  readLoopConfig,
  removeLoop,
  systemPromptPath,
  taskPath,
  writeLoopConfig,
} from "./store.ts";
import { installLoopCron, isLoopCronInstalled, removeLoopCron } from "./cron.ts";
import type { LoopConfig } from "./types.ts";

// parseFlags 简单的 --flag value 解析，不支持带空格的取值
function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const hasValue = i + 1 < argv.length && !argv[i + 1]!.startsWith("--");
      flags[key] = hasValue ? argv[++i]! : "";
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function handleCreate(ctx: ExtensionContext, argStr: string): Promise<void> {
  const { positional, flags } = parseFlags(argStr.split(/\s+/).filter(Boolean));
  const [name, agentName] = positional;
  if (!name || !agentName) {
    ctx.ui.notify("用法: /loop create <name> <agent> --interval 30m [--model Au]", "warning");
    return;
  }
  if (loopExists(ctx.cwd, name)) {
    ctx.ui.notify(`loop "${name}" 已存在，先 /loop remove ${name} 再重建`, "warning");
    return;
  }
  if (!flags.interval) {
    ctx.ui.notify("缺少 --interval，例如 --interval 30m 或 --interval 2h", "warning");
    return;
  }

  const resolved = resolveLoopAgent(ctx.cwd, agentName, flags.model ? resolveModelName(flags.model) : undefined);
  if (!resolved) {
    ctx.ui.notify(`未找到 agent "${agentName}"（.pi/agents 或 ~/.pi/agent/agents 下的 .md 定义）`, "error");
    return;
  }

  let cronExpr: string;
  try {
    cronExpr = parseInterval(flags.interval);
  } catch (err) {
    ctx.ui.notify((err as Error).message, "error");
    return;
  }

  const config: LoopConfig = {
    name,
    agent: agentName,
    model: resolved.model,
    tools: resolved.agent.tools,
    interval: flags.interval,
    cronExpr,
    cwd: ctx.cwd,
    createdAt: new Date().toISOString(),
  };

  writeLoopConfig(ctx.cwd, config);
  fs.writeFileSync(systemPromptPath(ctx.cwd, name), resolved.agent.systemPrompt, "utf-8");
  const taskFile = taskPath(ctx.cwd, name);
  if (!fs.existsSync(taskFile)) {
    fs.writeFileSync(
      taskFile,
      `<!-- loop "${name}" 的任务内容，随时编辑保存即可，下一轮触发时会读取最新内容 -->\n\n`,
      "utf-8",
    );
  }

  ctx.ui.notify(
    `loop "${name}" 已创建（agent=${agentName}${config.model ? `, model=${config.model}` : ""}）。\n` +
      `编辑 ${taskFile} 填任务，再 /loop start ${name} 开始。`,
    "info",
  );
}

async function handleStart(ctx: ExtensionContext, name: string | undefined): Promise<void> {
  if (!name) return ctx.ui.notify("用法: /loop start <name>", "warning");
  const config = readLoopConfig(ctx.cwd, name);
  if (!config) return ctx.ui.notify(`未找到 loop "${name}"（先 /loop create）`, "error");

  try {
    const command = buildLoopCommand(config);
    installLoopCron(name, config.cronExpr, command);
    ctx.ui.notify(`已装入 crontab：${config.cronExpr}  "${command}"`, "info");
  } catch (err) {
    ctx.ui.notify(`装 crontab 失败：${(err as Error).message}（本机是否安装了 cron？）`, "error");
  }
}

async function handleStop(ctx: ExtensionContext, name: string | undefined): Promise<void> {
  if (!name) return ctx.ui.notify("用法: /loop stop <name>", "warning");
  const removed = removeLoopCron(name);
  ctx.ui.notify(removed ? `已从 crontab 移除 "${name}"` : `"${name}" 本来就没在 crontab 里`, "info");
}

async function handleRemove(ctx: ExtensionContext, name: string | undefined): Promise<void> {
  if (!name) return ctx.ui.notify("用法: /loop remove <name>", "warning");
  if (!loopExists(ctx.cwd, name)) return ctx.ui.notify(`未找到 loop "${name}"`, "error");

  const ok = await ctx.ui.confirm(
    "删除 loop",
    `确认删除 "${name}"？会移除 crontab 条目，并删掉 .pi/taropi/loop/${name}/ 下所有文件（含历史日志）。`,
  );
  if (!ok) return;

  removeLoopCron(name);
  removeLoop(ctx.cwd, name);
  ctx.ui.notify(`"${name}" 已删除`, "info");
}

async function handleList(ctx: ExtensionContext): Promise<void> {
  const loops = listLoops(ctx.cwd);
  if (loops.length === 0) return ctx.ui.notify("暂无 loop（/loop create 创建一个）", "info");

  const lines = loops.map((c) => {
    const active = isLoopCronInstalled(c.name);
    const runs = listRuns(ctx.cwd, c.name);
    return `${active ? "▶" : "⏸"} ${c.name}  agent=${c.agent}${c.model ? ` model=${c.model}` : ""}  interval=${c.interval}  runs=${runs.length}`;
  });
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleStatus(ctx: ExtensionContext, name: string | undefined): Promise<void> {
  if (!name) return ctx.ui.notify("用法: /loop status <name>", "warning");
  const config = readLoopConfig(ctx.cwd, name);
  if (!config) return ctx.ui.notify(`未找到 loop "${name}"`, "error");

  const active = isLoopCronInstalled(name);
  const runs = listRuns(ctx.cwd, name);
  const last = runs[runs.length - 1];
  const lines = [
    `${name}  ${active ? "运行中" : "已停止"}`,
    `agent=${config.agent}${config.model ? `  model=${config.model}` : ""}`,
    `interval=${config.interval}（cron: ${config.cronExpr}）`,
    `已运行 ${runs.length} 轮${last ? `，最近一次：${last.replace(".log", "")}` : ""}`,
    `task 文件：${taskPath(ctx.cwd, name)}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleEdit(ctx: ExtensionContext, name: string | undefined): Promise<void> {
  if (!name) return ctx.ui.notify("用法: /loop edit <name>", "warning");
  if (!loopExists(ctx.cwd, name)) return ctx.ui.notify(`未找到 loop "${name}"`, "error");

  const file = taskPath(ctx.cwd, name);
  const current = fs.readFileSync(file, "utf-8");
  const next = await ctx.ui.editor(`编辑 loop "${name}" 的任务`, current);
  if (next === undefined) return; // 用户取消
  fs.writeFileSync(file, next, "utf-8");
  ctx.ui.notify(`已保存 ${file}`, "info");
}

export function registerLoop(pi: ExtensionAPI): void {
  pi.registerCommand("loop", {
    description: "定时循环执行一个 agent 定义的任务（crontab 驱动，每轮独立进程/独立 session）",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(" ");
      const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      const restFirstToken = rest.split(/\s+/)[0] || undefined;

      switch (sub) {
        case "create":
          return handleCreate(ctx, rest);
        case "start":
          return handleStart(ctx, restFirstToken);
        case "stop":
          return handleStop(ctx, restFirstToken);
        case "remove":
          return handleRemove(ctx, restFirstToken);
        case "list":
          return handleList(ctx);
        case "status":
          return handleStatus(ctx, restFirstToken);
        case "edit":
          return handleEdit(ctx, restFirstToken);
        default:
          ctx.ui.notify(
            "用法: /loop create|start|stop|list|status|edit|remove ...\n" +
              "  /loop create <name> <agent> --interval 30m [--model Au]",
            "info",
          );
      }
    },
  });
}
