import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceNextAt,
  advanceRegistryRules,
  armRegistryRules,
  buildRegistryRules,
  getRegistryDirectory,
  hasEnabledRules,
  listRegistryEntries,
  nextDueAt,
  pruneRegistryEntries,
  readRegistryEntry,
  removeRegistryEntry,
  resumeRegistryRules,
  writeRegistryEntry,
  type RegistryEntry,
} from "./registry.ts";
import type { AutoCompactRule } from "./types.ts";

const now = new Date(2026, 10, 5, 12, 0, 0).getTime();
const every: AutoCompactRule = { id: "e", enabled: true, type: "every", value: 30, unit: "m" };
const idle: AutoCompactRule = { id: "i", enabled: true, type: "idle", value: 1, unit: "h" };
const cron: AutoCompactRule = { id: "c", enabled: true, type: "cron", cron: "0 3 * * *" };
const disabled: AutoCompactRule = { id: "off", enabled: false, type: "every", value: 5, unit: "m" };

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "taropi-registry-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(agentDir, { recursive: true, force: true });
});

function entry(rules: RegistryEntry["rules"], sessionId = "sess-1"): RegistryEntry {
  return { version: 1, sessionId, cwd: "/work/a", updatedAt: now, rules };
}

describe("离线压缩注册表", () => {
  it("目录落在 Pi 配置目录下的 taropi 子目录", async () => {
    expect(getRegistryDirectory()).toBe(join(agentDir, "taropi", "auto-compact"));
  });

  it("写入后可读回，覆写会替换旧内容", async () => {
    await writeRegistryEntry(entry(buildRegistryRules([every], now)));
    const first = await readRegistryEntry("sess-1");
    expect(first?.cwd).toBe("/work/a");
    expect(first?.rules[0]?.nextAt).toBe(now + 30 * 60_000);

    await writeRegistryEntry(entry(buildRegistryRules([idle], now), "sess-1"));
    const second = await readRegistryEntry("sess-1");
    expect(second?.rules.map((rule) => rule.id)).toEqual(["i"]);
  });

  it("会话名随条目存取，缺失时仍有效", async () => {
    await writeRegistryEntry({ ...entry(buildRegistryRules([every], now)), name: "PC互动表态兼容" });
    expect((await readRegistryEntry("sess-1"))?.name).toBe("PC互动表态兼容");
    await writeRegistryEntry(entry(buildRegistryRules([every], now), "sess-2"));
    expect((await readRegistryEntry("sess-2"))?.name).toBeUndefined();
  });

  it("损坏文件被跳过，删除不存在的条目不报错", async () => {
    await mkdir(join(getRegistryDirectory(), "sessions"), { recursive: true });
    await writeFile(join(getRegistryDirectory(), "sessions", "broken.json"), "{not json", "utf8");
    expect(await readRegistryEntry("broken")).toBeUndefined();
    expect(await listRegistryEntries()).toEqual([]);
    await removeRegistryEntry("missing");
    expect(await readRegistryEntry("sess-1")).toBeUndefined();
  });

  it("非法会话 id 不会被拼进路径", async () => {
    expect(await readRegistryEntry("../escape")).toBeUndefined();
    await writeRegistryEntry({ ...entry([], "../escape"), sessionId: "../escape" });
    expect(await listRegistryEntries()).toEqual([]);
  });

  it("列表按会话 id 稳定排序并跳过停用条目保留的旧记录", async () => {
    await writeRegistryEntry(entry(buildRegistryRules([every], now), "b-sess"));
    await writeRegistryEntry(entry(buildRegistryRules([every], now), "a-sess"));
    const list = await listRegistryEntries();
    expect(list.map((item) => item.sessionId)).toEqual(["a-sess", "b-sess"]);
    const raw = JSON.parse(await readFile(join(getRegistryDirectory(), "sessions", "a-sess.json"), "utf8")) as RegistryEntry;
    expect(raw.rules).toHaveLength(1);
  });

  it("按判定清理失效条目", async () => {
    await writeRegistryEntry(entry(buildRegistryRules([every], now), "keep"));
    await writeRegistryEntry(entry(buildRegistryRules([every], now), "drop"));
    const removed = await pruneRegistryEntries((item) => item.sessionId === "keep");
    expect(removed).toEqual(["drop"]);
    expect((await listRegistryEntries()).map((item) => item.sessionId)).toEqual(["keep"]);
  });
});

describe("下一次压缩时间", () => {
  it("every 从当前时间加间隔，cron 取下一个匹配点，idle 与停用不武装", () => {
    expect(advanceNextAt(every, now)).toBe(now + 30 * 60_000);
    expect(advanceNextAt({ ...cron, cron: "0 3 * * *" }, now)).toBe(new Date(2026, 10, 6, 3, 0, 0).getTime());
    expect(advanceNextAt(idle, now)).toBeNull();
    expect(advanceNextAt(disabled, now)).toBeNull();
    expect(advanceNextAt({ ...cron, cron: "bad" }, now)).toBeNull();
  });

  it("到期时间取启用规则中最早的一个", () => {
    const rules = buildRegistryRules([every, cron, disabled], now);
    expect(nextDueAt(entry(rules))).toBe(now + 30 * 60_000);
    expect(nextDueAt(entry(buildRegistryRules([disabled], now)))).toBeUndefined();
    expect(nextDueAt(entry(buildRegistryRules([idle], now)))).toBeUndefined();
  });

  it("恢复时保留未到期计划，已过期的重新计算", () => {
    const previous = buildRegistryRules([every, cron], now);
    expect(resumeRegistryRules(previous, [every, cron], now + 60_000).map((rule) => rule.nextAt)).toEqual(previous.map((rule) => rule.nextAt));
    expect(resumeRegistryRules(previous, [every, cron], now + 40 * 60_000)[0]?.nextAt).toBe(now + 70 * 60_000);
    expect(resumeRegistryRules(previous, [{ ...every, value: 10 }], now)[0]?.nextAt).toBe(now + 10 * 60_000);
  });

  it("活动后只重新武装闲置策略，压缩后整体推进", () => {
    const rules = buildRegistryRules([every, idle, cron], now);
    const armed = armRegistryRules(rules, now + 5_000);
    expect(armed.find((rule) => rule.id === "i")?.nextAt).toBe(now + 5_000 + 3_600_000);
    expect(armed.find((rule) => rule.id === "e")?.nextAt).toBe(now + 30 * 60_000);
    expect(armed.find((rule) => rule.id === "c")?.nextAt).toBe(rules.find((rule) => rule.id === "c")?.nextAt);

    const advanced = advanceRegistryRules(rules, now + 60_000);
    expect(advanced.find((rule) => rule.id === "e")?.nextAt).toBe(now + 60_000 + 30 * 60_000);
    expect(advanced.find((rule) => rule.id === "i")?.nextAt).toBeNull();
  });

  it("有启用规则时才算需要登记", () => {
    expect(hasEnabledRules([idle])).toBe(true);
    expect(hasEnabledRules([disabled])).toBe(false);
    expect(hasEnabledRules([])).toBe(false);
    expect(buildRegistryRules([], now)).toEqual([]);
  });
});
