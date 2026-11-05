// 安装每分钟扫描一次离线压缩任务的系统 crontab 条目。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRegistryDirectory } from "./registry.ts";

export const SCANNER_CRON_MARKER = "# taropi:auto-compact-scanner";

export interface CrontabDeps {
  read?: () => Promise<string>;
  write?: (content: string) => Promise<void>;
  marker?: string;
  command?: string;
}

export interface CrontabResult {
  status: "created" | "updated" | "unchanged" | "removed" | "absent" | "failed";
  message?: string;
}

// getScannerPath 返回扫描器模块的绝对路径。
export function getScannerPath(): string {
  return fileURLToPath(new URL("./scanner.ts", import.meta.url));
}

// getScannerLogPath 返回扫描器追记日志的文件路径。
export function getScannerLogPath(): string {
  return join(getRegistryDirectory(), "scanner.log");
}

// getCronNodePath 返回执行扫描器的运行时路径，可用 TAROPI_NODE_BIN 覆盖。
export function getCronNodePath(): string {
  const override = process.env.TAROPI_NODE_BIN?.trim();
  return override || process.execPath;
}

// buildScannerCronLine 生成带标记的 crontab 行。
export function buildScannerCronLine(overrides: { node?: string; scanner?: string; log?: string } = {}): string {
  const node = overrides.node ?? getCronNodePath();
  const scanner = overrides.scanner ?? getScannerPath();
  const log = overrides.log ?? getScannerLogPath();
  return `* * * * * mkdir -p "${getRegistryDirectory()}" && "${node}" "${scanner}" >> "${log}" 2>&1 ${SCANNER_CRON_MARKER}`;
}

// ensureScannerCron 保证 crontab 中存在且仅存在一条最新的扫描条目。
export async function ensureScannerCron(deps: CrontabDeps = {}): Promise<CrontabResult> {
  const marker = deps.marker ?? SCANNER_CRON_MARKER;
  const desired = deps.command ?? buildScannerCronLine();
  try {
    const lines = splitLines(await (deps.read ?? readCrontab)());
    const existing = lines.filter((line) => line.includes(marker));
    if (existing.length === 1 && existing[0] === desired) return { status: "unchanged" };
    const kept = lines.filter((line) => !line.includes(marker));
    kept.push(desired);
    await (deps.write ?? writeCrontab)(`${kept.join("\n")}\n`);
    return { status: existing.length === 0 ? "created" : "updated" };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

// hasScannerCron 判断 crontab 中是否已安装扫描条目。
export async function hasScannerCron(deps: CrontabDeps = {}): Promise<boolean> {
  const marker = deps.marker ?? SCANNER_CRON_MARKER;
  try {
    const lines = splitLines(await (deps.read ?? readCrontab)());
    return lines.some((line) => line.includes(marker));
  } catch {
    return false;
  }
}

// removeScannerCron 移除扫描条目，不存在时不视为失败。
export async function removeScannerCron(deps: CrontabDeps = {}): Promise<CrontabResult> {
  const marker = deps.marker ?? SCANNER_CRON_MARKER;
  try {
    const lines = splitLines(await (deps.read ?? readCrontab)());
    const kept = lines.filter((line) => !line.includes(marker));
    if (kept.length === lines.length) return { status: "absent" };
    await (deps.write ?? writeCrontab)(kept.length === 0 ? "" : `${kept.join("\n")}\n`);
    return { status: "removed" };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// readCrontab 读取当前用户的 crontab，没有安装时返回空文本。
async function readCrontab(): Promise<string> {
  try {
    return await runCrontab(["-l"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no crontab/i.test(message)) return "";
    throw error;
  }
}

function writeCrontab(content: string): Promise<void> {
  return runCrontab(["-"], content).then(() => undefined);
}

function runCrontab(args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("crontab", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `crontab 退出码 ${code}`));
    });
    child.stdin.end(input);
  });
}
