import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLiveness } from "./liveness.ts";
import { OfflineCompactSync, type OfflineSyncHost } from "./offline.ts";
import { listRegistryEntries, readRegistryEntry } from "./registry.ts";
import type { AutoCompactRule } from "./types.ts";

const now = new Date(2026, 10, 5, 12, 0, 0).getTime();
const every: AutoCompactRule = { id: "e", enabled: true, type: "every", value: 30, unit: "m" };
const idle: AutoCompactRule = { id: "i", enabled: true, type: "idle", value: 1, unit: "h" };

let agentDir: string;
let livenessDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "taropi-offline-agent-"));
  livenessDir = await mkdtemp(join(tmpdir(), "taropi-offline-liveness-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(agentDir, { recursive: true, force: true });
  await rm(livenessDir, { recursive: true, force: true });
});

function host(sessionId = "sess-1"): OfflineSyncHost {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => "/work/a",
      getSessionFile: () => "/sessions/a.jsonl",
    },
  };
}

function sync(warn = vi.fn()) {
  const ensureCron = vi.fn(async () => ({ status: "created" as const }));
  const liveness = new SessionLiveness({ directory: livenessDir });
  const instance = new OfflineCompactSync({
    liveness,
    ensureCron,
    cronInstalled: async () => true,
    removeCron: async () => ({ status: "removed" as const }),
    warn,
    now: () => now,
  });
  return { instance, ensureCron, warn, liveness };
}

describe("离线同步", () => {
  it("启动时把启用策略写入注册表并安装 cron", async () => {
    const { instance, ensureCron } = sync();
    await instance.start([every, idle], host());
    const entry = await readRegistryEntry("sess-1");
    expect(entry?.cwd).toBe("/work/a");
    expect(entry?.sessionFile).toBe("/sessions/a.jsonl");
    expect(entry?.rules.find((rule) => rule.id === "e")?.nextAt).toBe(now + 30 * 60_000);
    expect(entry?.rules.find((rule) => rule.id === "i")?.nextAt).toBeNull();
    expect(ensureCron).toHaveBeenCalled();
  });

  it("没有启用策略时不写注册表，并清掉旧条目", async () => {
    const { instance, ensureCron } = sync();
    await instance.start([every], host());
    await instance.save([{ ...every, enabled: false }], host());
    expect(await readRegistryEntry("sess-1")).toBeUndefined();
    expect(ensureCron).toHaveBeenCalledTimes(1);
  });

  it("保存策略后重算到期时间", async () => {
    const { instance } = sync();
    await instance.save([every], host());
    expect((await readRegistryEntry("sess-1"))?.rules[0]?.nextAt).toBe(now + 30 * 60_000);
  });

  it("活动后重新武装闲置策略，压缩后推进 every", async () => {
    const { instance } = sync();
    await instance.start([every, idle], host());
    await instance.recordActivity(host());
    const armed = await readRegistryEntry("sess-1");
    expect(armed?.lastActiveAt).toBe(now);
    expect(armed?.rules.find((rule) => rule.id === "i")?.nextAt).toBe(now + 3_600_000);
    expect(armed?.rules.find((rule) => rule.id === "e")?.nextAt).toBe(now + 30 * 60_000);

    await instance.recordCompacted(host());
    const advanced = await readRegistryEntry("sess-1");
    expect(advanced?.rules.find((rule) => rule.id === "e")?.nextAt).toBe(now + 30 * 60_000);
    expect(advanced?.rules.find((rule) => rule.id === "i")?.nextAt).toBeNull();
  });

  it("没有注册表条目时活动与压缩不报错也不创建", async () => {
    const { instance, warn } = sync();
    await instance.recordActivity(host());
    await instance.recordCompacted(host());
    expect(await listRegistryEntries()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cron 安装失败时只告警，状态写入照常完成", async () => {
    const warn = vi.fn();
    const instance = new OfflineCompactSync({
      liveness: new SessionLiveness({ directory: livenessDir }),
      ensureCron: async () => ({ status: "failed", message: "crontab: not found" }),
      warn,
      now: () => now,
    });
    await instance.start([every], host());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("crontab: not found"));
    expect(await readRegistryEntry("sess-1")).toBeDefined();
  });

  it("状态汇总 cron 与注册表，移除 cron 返回结果", async () => {
    const { instance } = sync();
    await instance.start([every], host());
    const status = await instance.status();
    expect(status.cronInstalled).toBe(true);
    expect(status.entries.map((entry) => entry.sessionId)).toEqual(["sess-1"]);
    expect((await instance.removeCronTask()).status).toBe("removed");
  });

  it("会话 id 或目录缺失时跳过写入", async () => {
    const { instance } = sync();
    await instance.start([every], { sessionManager: { getSessionId: () => "", getCwd: () => "/work/a", getSessionFile: () => undefined } });
    expect(await listRegistryEntries()).toEqual([]);
  });
});
