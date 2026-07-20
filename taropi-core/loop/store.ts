/**
 * loop 的落盘布局：.pi/taropi/loop/<name>/{config.json, task.md, system-prompt.md, runs/*.log}
 *
 * runs/ 下每轮一个独立文件，迭代次数、最近一次运行时间都直接从文件系统派生，
 * 不额外维护一份会被"交互式会话"和"crontab 触发的独立进程"并发写坏的状态字段。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopConfig } from "./types.ts";

function loopRoot(cwd: string): string {
  return path.join(cwd, ".pi", "taropi", "loop");
}

export function loopDir(cwd: string, name: string): string {
  return path.join(loopRoot(cwd), name);
}

export function configPath(cwd: string, name: string): string {
  return path.join(loopDir(cwd, name), "config.json");
}

export function taskPath(cwd: string, name: string): string {
  return path.join(loopDir(cwd, name), "task.md");
}

export function systemPromptPath(cwd: string, name: string): string {
  return path.join(loopDir(cwd, name), "system-prompt.md");
}

export function runsDir(cwd: string, name: string): string {
  return path.join(loopDir(cwd, name), "runs");
}

export function loopExists(cwd: string, name: string): boolean {
  return fs.existsSync(configPath(cwd, name));
}

export function readLoopConfig(cwd: string, name: string): LoopConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(configPath(cwd, name), "utf-8")) as LoopConfig;
  } catch {
    return undefined;
  }
}

export function writeLoopConfig(cwd: string, config: LoopConfig): void {
  fs.mkdirSync(loopDir(cwd, config.name), { recursive: true });
  fs.mkdirSync(runsDir(cwd, config.name), { recursive: true });
  fs.writeFileSync(configPath(cwd, config.name), JSON.stringify(config, null, 2), "utf-8");
}

export function listLoops(cwd: string): LoopConfig[] {
  const root = loopRoot(cwd);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readLoopConfig(cwd, e.name))
    .filter((c): c is LoopConfig => !!c);
}

export function removeLoop(cwd: string, name: string): void {
  fs.rmSync(loopDir(cwd, name), { recursive: true, force: true });
}

export function listRuns(cwd: string, name: string): string[] {
  const dir = runsDir(cwd, name);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .sort();
}

// parseInterval 把简写间隔("30m"/"2h")或原始 5 段 cron 表达式统一展开成 cron 表达式
export function parseInterval(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.split(/\s+/).length === 5) return trimmed; // 已经是 cron 表达式，直接透传

  const match = trimmed.match(/^(\d+)(m|h)$/i);
  if (!match) {
    throw new Error(`无法解析的间隔: "${raw}"，支持 "30m" / "2h" 简写，或原始 5 段 cron 表达式`);
  }
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();

  if (unit === "m") {
    if (n < 1 || n > 59) throw new Error("分钟间隔需要在 1-59 之间，更长周期请用小时单位或原始 cron 表达式");
    return `*/${n} * * * *`;
  }
  if (n < 1 || n > 23) throw new Error('小时间隔需要在 1-23 之间，更长周期请用原始 cron 表达式，如 "0 0 * * *" 表示每天一次');
  return `0 */${n} * * *`;
}

// shq 用单引号包裹一段字符串用于 shell 命令，安全转义内部的单引号
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// getPiInvocation 解析当前 pi 可执行文件的绝对调用方式
// crontab 环境 PATH 很有限，尽量拿绝对路径，避免裸 "pi" 解析不到
function getPiInvocation(): string {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return `${shq(process.execPath)} ${shq(currentScript)}`;
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return shq(process.execPath);

  return "pi"; // 兜底：假设 crontab 的 PATH 里能找到 pi
}

// buildLoopCommand 构造 crontab 里真正执行的 shell 命令：
// - --model/--tools/--append-system-prompt 是创建时解析好的固定参数
// - 任务文本用 "$(cat task.md)" 在触发时现读现填，实现"随时可编辑"
// - % 在 crontab 里有特殊含义（转义为换行），date 格式串里的 % 必须转义成 \%
export function buildLoopCommand(config: LoopConfig): string {
  const parts = [getPiInvocation(), "-p", "--no-session"];
  if (config.model) parts.push("--model", shq(config.model));
  if (config.tools && config.tools.length > 0) parts.push("--tools", shq(config.tools.join(",")));
  parts.push("--append-system-prompt", shq(systemPromptPath(config.cwd, config.name)));

  const taskFile = shq(taskPath(config.cwd, config.name));
  const logFile = path.join(runsDir(config.cwd, config.name), "$(date +\\%Y\\%m\\%dT\\%H\\%M\\%S).log");

  return `cd ${shq(config.cwd)} && ${parts.join(" ")} "$(cat ${taskFile})" > ${logFile} 2>&1`;
}
