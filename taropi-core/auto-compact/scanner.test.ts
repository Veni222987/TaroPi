import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegistryRules, getRegistryDirectory, readRegistryEntry, writeRegistryEntry, type RegistryEntry } from "./registry.ts";
import { acquireScannerLock, compactSessionOffline, planDueEntries, runScannerOnce } from "./scanner.ts";
import type { AutoCompactRule } from "./types.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const now = new Date(2026, 10, 5, 12, 0, 0).getTime();
const every: AutoCompactRule = { id: "e", enabled: true, type: "every", value: 30, unit: "m" };

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "taropi-scanner-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  await rm(agentDir, { recursive: true, force: true });
});

function entry(sessionId: string, dueOffset: number, rules: AutoCompactRule[] = [every]): RegistryEntry {
  const base = buildRegistryRules(rules, now);
  return {
    version: 1,
    sessionId,
    cwd: "/work/a",
    updatedAt: now,
    rules: base.map((rule) => ({ ...rule, nextAt: rule.type === "idle" ? null : now + dueOffset })),
  };
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  stdin: { write: (chunk: string) => void; end: () => void };
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe("离线扫描挑选", () => {
  it("只选到期且无活动进程的会话，按到期时间升序", () => {
    const entries = [entry("a", 60_000), entry("b", -1_000), entry("c", -5_000), entry("d", 0)];
    const planned = planDueEntries(entries, now, new Set(["c"]));
    expect(planned.map((item) => item.sessionId)).toEqual(["b", "d"]);
  });

  it("停用规则与未武装的闲置策略不产生候选", () => {
    const disabled: AutoCompactRule = { id: "off", enabled: false, type: "every", value: 1, unit: "m" };
    const idle: AutoCompactRule = { id: "i", enabled: true, type: "idle", value: 1, unit: "h" };
    expect(planDueEntries([entry("a", -1_000, [disabled])], now, new Set())).toEqual([]);
    expect(planDueEntries([entry("b", -1_000, [idle])], now, new Set())).toEqual([]);
  });
});

describe("拉起离线压缩", () => {
  it("以会话目录拉起 rpc 并要求压缩", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const promise = compactSessionOffline({ sessionId: "sess-1", cwd: "/work/a", dueAt: now }, { piBinary: "/fake/pi" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawn).toHaveBeenCalledWith("/fake/pi", ["--session", "sess-1", "--mode", "rpc"], { cwd: "/work/a", stdio: ["pipe", "pipe", "pipe"] });
    expect(child.stdin.write).toHaveBeenCalledWith(`${JSON.stringify({ type: "compact" })}\n`);
    expect(child.stdin.end).not.toHaveBeenCalled();
    child.stdout.emit("data", `${JSON.stringify({ type: "response", command: "compact", success: true })}\n`);
    await expect(promise).resolves.toEqual({ sessionId: "sess-1", status: "compacted" });
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("压缩失败与进程异常退出都会返回 failed", async () => {
    const failing = fakeChild();
    vi.mocked(spawn).mockReturnValue(failing as never);
    const first = compactSessionOffline({ sessionId: "sess-1", cwd: "/work/a", dueAt: now });
    await new Promise((resolve) => setTimeout(resolve, 0));
    failing.stdout.emit("data", `${JSON.stringify({ type: "response", command: "compact", success: false, error: "Nothing to compact" })}\n`);
    await expect(first).resolves.toEqual({ sessionId: "sess-1", status: "failed", message: "Nothing to compact" });

    const crashed = fakeChild();
    vi.mocked(spawn).mockReturnValue(crashed as never);
    const second = compactSessionOffline({ sessionId: "sess-2", cwd: "/work/a", dueAt: now });
    await new Promise((resolve) => setTimeout(resolve, 0));
    crashed.emit("close", 2);
    await expect(second).resolves.toEqual({ sessionId: "sess-2", status: "failed", message: "pi 退出码 2" });
  });

  it("超时后杀掉子进程并返回 timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const promise = compactSessionOffline({ sessionId: "sess-1", cwd: "/work/a", dueAt: now }, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ status: "timeout" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });
});

describe("扫描一轮", () => {
  it("清理停用条目并逐个拉起到期会话", async () => {
    await writeRegistryEntry(entry("due", -1_000));
    await writeRegistryEntry(entry("future", 60_000));
    await writeRegistryEntry(entry("off", -1_000, [{ id: "x", enabled: false, type: "every", value: 1, unit: "m" }]));
    const spawnCompact = vi.fn(async (candidate: { sessionId: string }) => ({ sessionId: candidate.sessionId, status: "compacted" as const }));
    const logs: string[] = [];
    const results = await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact, log: (message) => logs.push(message) });
    expect(results).toEqual([{ sessionId: "due", status: "compacted" }]);
    expect(spawnCompact).toHaveBeenCalledOnce();
    expect(logs.some((line) => line.includes("due compacted"))).toBe(true);
  });

  it("活跃会话被跳过，失败的条目也推进到下一周期", async () => {
    await writeRegistryEntry(entry("busy", -1_000));
    await writeRegistryEntry(entry("broken", -2_000));
    const spawnCompact = vi.fn(async (candidate: { sessionId: string }) => ({ sessionId: candidate.sessionId, status: "failed" as const, message: "boom" }));
    const first = await runScannerOnce({ now, activeSessionIds: new Set(["busy"]), spawnCompact });
    expect(first.map((item) => item.sessionId)).toEqual(["broken"]);
    const second = await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact });
    expect(second.map((item) => item.sessionId)).toEqual(["busy"]);
    const third = await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact });
    expect(third).toEqual([]);
  });

  it("成功压缩后也推进下一次时间，不会每分钟重复拉起", async () => {
    await writeRegistryEntry(entry("ok", -1_000));
    const spawnCompact = vi.fn(async (candidate: { sessionId: string }) => ({ sessionId: candidate.sessionId, status: "compacted" as const }));
    await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact });
    expect((await readRegistryEntry("ok"))?.rules[0]?.nextAt).toBeGreaterThan(now);
    expect(await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact })).toEqual([]);
  });

  it("只有闲置策略时压缩后推进为空，条目被移除", async () => {
    const idle: AutoCompactRule = { id: "i", enabled: true, type: "idle", value: 1, unit: "h" };
    await writeRegistryEntry({ ...entry("idle", 0, [idle]), rules: [{ ...idle, nextAt: now - 1 }] });
    const spawnCompact = vi.fn(async () => ({ sessionId: "idle", status: "compacted" as const }));
    await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact });
    expect(await readRegistryEntry("idle")).toBeUndefined();
  });

  it("会话文件已删除的条目被清理", async () => {
    await writeRegistryEntry({ ...entry("gone", -1_000), sessionFile: join(agentDir, "missing.jsonl") });
    const results = await runScannerOnce({ now, activeSessionIds: new Set(), spawnCompact: vi.fn() });
    expect(results).toEqual([]);
    const files = await readFile(join(getRegistryDirectory(), "sessions", "gone.json"), "utf8").catch(() => undefined);
    expect(files).toBeUndefined();
  });
});

describe("扫描锁", () => {
  it("同一时间只能有一把锁，释放后可重抢", async () => {
    await mkdir(getRegistryDirectory(), { recursive: true });
    const release = await acquireScannerLock(now);
    expect(release).toBeTypeOf("function");
    expect(await acquireScannerLock(now)).toBeUndefined();
    await release!();
    const again = await acquireScannerLock(now);
    expect(again).toBeTypeOf("function");
    await again!();
  });

  it("持有者进程已退出时旧锁可以被接管", async () => {
    await mkdir(getRegistryDirectory(), { recursive: true });
    await writeFile(join(getRegistryDirectory(), "scanner.lock"), JSON.stringify({ version: 1, pid: 999_999_999, updatedAt: now }), "utf8");
    const release = await acquireScannerLock(now);
    expect(release).toBeTypeOf("function");
    await release!();
  });
});
