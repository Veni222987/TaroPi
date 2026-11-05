import { describe, expect, it, vi } from "vitest";
import {
  buildScannerCronLine,
  ensureScannerCron,
  hasScannerCron,
  removeScannerCron,
  SCANNER_CRON_MARKER,
  type CrontabDeps,
} from "./crontab.ts";

function deps(initial: string): CrontabDeps & { written: string[] } {
  const written: string[] = [];
  let content = initial;
  return {
    written,
    read: async () => content,
    write: async (next) => {
      written.push(next);
      content = next;
    },
  };
}

const other = "*/10 * * * * /usr/local/bin/backup";
const command = `* * * * * "node" "scanner.ts" >> "log" 2>&1 ${SCANNER_CRON_MARKER}`;

describe("cron 任务安装", () => {
  it("首安装保留已有任务，并追加带标记的扫描行", async () => {
    const target = deps(`${other}\n`);
    expect(await ensureScannerCron({ ...target, command })).toEqual({ status: "created" });
    expect(target.written).toEqual([`${other}\n${command}\n`]);
  });

  it("已存在且一致时不做任何写入", async () => {
    const target = deps(`${other}\n${command}\n`);
    expect(await ensureScannerCron({ ...target, command })).toEqual({ status: "unchanged" });
    expect(target.written).toEqual([]);
  });

  it("命令变化时替换旧行，不重复叠加", async () => {
    const target = deps(`${other}\n* * * * * old ${SCANNER_CRON_MARKER}\n`);
    expect(await ensureScannerCron({ ...target, command })).toEqual({ status: "updated" });
    expect(target.written[0]!.split("\n").filter(Boolean)).toEqual([other, command]);
  });

  it("crontab 读取失败时返回 failed，不抛错", async () => {
    const result = await ensureScannerCron({
      command,
      read: async () => {
        throw new Error("crontab: not found");
      },
      write: async () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("not found");
  });

  it("检查与移除只处理带标记的行", async () => {
    const target = deps(`${other}\n${command}\n`);
    expect(await hasScannerCron(target)).toBe(true);
    expect(await removeScannerCron(target)).toEqual({ status: "removed" });
    expect(target.written).toEqual([`${other}\n`]);
    expect(await removeScannerCron(target)).toEqual({ status: "absent" });
    expect(await hasScannerCron(target)).toBe(false);
  });

  it("移除后 crontab 为空时写入空文本", async () => {
    const target = deps(`${command}\n`);
    expect(await removeScannerCron(target)).toEqual({ status: "removed" });
    expect(target.written).toEqual([""]);
  });

  it("生成的命令行包含运行时、扫描器、日志与标记", () => {
    const line = buildScannerCronLine({ node: "/usr/bin/node", scanner: "/a/scanner.ts", log: "/a/scanner.log" });
    expect(line).toContain("/usr/bin/node");
    expect(line).toContain("/a/scanner.ts");
    expect(line).toContain("/a/scanner.log");
    expect(line.endsWith(SCANNER_CRON_MARKER)).toBe(true);
    expect(line.startsWith("* * * * * ")).toBe(true);
  });

  it("默认读取使用 crontab 命令，缺失时视为空表", async () => {
    const spawn = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.resetModules();
    const module = await import("./crontab.ts");
    expect(module.buildScannerCronLine()).toContain("scanner.ts");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
