import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActiveSessionIds, readLivenessRecords, SessionLiveness, type LivenessRecord } from "./liveness.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taropi-liveness-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("会话心跳", () => {
  it("启动后写入心跳文件，停止后删除", async () => {
    const liveness = new SessionLiveness({ directory });
    liveness.start("sess-1");
    await flush();
    const file = join(directory, "sess-1.json");
    const record = JSON.parse(await readFile(file, "utf8")) as LivenessRecord;
    expect(record.sessionId).toBe("sess-1");
    expect(record.pid).toBe(process.pid);

    liveness.stop();
    await flush();
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("心跳定时器刷新更新时间", async () => {
    const liveness = new SessionLiveness({ directory, heartbeatMs: 20 });
    liveness.start("sess-2");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const first = JSON.parse(await readFile(join(directory, "sess-2.json"), "utf8")) as LivenessRecord;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = JSON.parse(await readFile(join(directory, "sess-2.json"), "utf8")) as LivenessRecord;
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    liveness.stop();
    await flush();
  });

  it("只读取存活进程且未过期的心跳", async () => {
    await mkdir(directory, { recursive: true });
    const write = (sessionId: string, updatedAt: number, pid: number) => writeFile(
      join(directory, `${sessionId}.json`),
      JSON.stringify({ version: 1, sessionId, pid, updatedAt }),
      "utf8",
    );
    await write("fresh", 10_000, 111);
    await write("stale", 1_000, 111);
    await write("dead", 10_000, 222);
    await writeFile(join(directory, "broken.json"), "{oops", "utf8");

    const active = await readActiveSessionIds({
      directory,
      now: () => 20_000,
      staleMs: 15_000,
      isProcessAlive: (pid) => pid === 111,
    });
    expect([...active]).toEqual(["fresh"]);
    expect((await readLivenessRecords(directory)).map((record) => record.sessionId).sort()).toEqual(["dead", "fresh", "stale"]);
  });

  it("目录不存在时返回空集合，非法会话 id 不写文件", async () => {
    expect([...await readActiveSessionIds({ directory: join(directory, "missing") })]).toEqual([]);
    const liveness = new SessionLiveness({ directory });
    liveness.start("../evil");
    await flush();
    liveness.stop();
    await flush();
    expect(await readLivenessRecords(directory)).toEqual([]);
  });
});
