/**
 * 系统 crontab 的读写：每个 loop 在 crontab 里占两行——
 *   # TaroPi-loop:<name>
 *   <cronExpr> <command>
 * 只增删自己带标记的那两行，不动用户原有的其它 cron 任务。
 */

import { execSync } from "node:child_process";

const MARKER_PREFIX = "# TaroPi-loop:";

function readCrontab(): string {
  try {
    return execSync("crontab -l", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return ""; // 没有 crontab（或为空）时 `crontab -l` 会非 0 退出
  }
}

function writeCrontab(content: string): void {
  execSync("crontab -", { input: content, encoding: "utf-8" });
}

// stripLoopBlock 去掉某个 loop 的标记行及紧跟着的那一行 cron 命令
function stripLoopBlock(lines: string[], name: string): string[] {
  const marker = `${MARKER_PREFIX}${name}`;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === marker) {
      i++; // 跳过紧跟的命令行
      continue;
    }
    out.push(lines[i]!);
  }
  return out;
}

// installLoopCron 安装（或替换）某个 loop 的 crontab 条目
export function installLoopCron(name: string, cronExpr: string, command: string): void {
  const current = readCrontab();
  const lines = current.split("\n").filter((l, i, arr) => !(l === "" && i === arr.length - 1));
  const stripped = stripLoopBlock(lines, name);
  const entry = [`${MARKER_PREFIX}${name}`, `${cronExpr} ${command}`];
  writeCrontab([...stripped, ...entry].join("\n") + "\n");
}

// removeLoopCron 从 crontab 移除某个 loop 的条目，返回是否真的移除了
export function removeLoopCron(name: string): boolean {
  const current = readCrontab();
  const lines = current.split("\n");
  const hadEntry = lines.some((l) => l.trim() === `${MARKER_PREFIX}${name}`);
  if (!hadEntry) return false;

  const stripped = stripLoopBlock(lines, name).filter((l, i, arr) => !(l === "" && i === arr.length - 1));
  writeCrontab(stripped.length > 0 ? stripped.join("\n") + "\n" : "");
  return true;
}

// isLoopCronInstalled 检查某个 loop 当前是否在 crontab 里
export function isLoopCronInstalled(name: string): boolean {
  const current = readCrontab();
  return current.split("\n").some((l) => l.trim() === `${MARKER_PREFIX}${name}`);
}
