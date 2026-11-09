import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSessionPresenceStore,
  groupAgentDirectories,
  type AgentSessionPresence,
} from "./session-presence.ts";

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taropi-hud-test-"));
  directories.push(directory);
  return directory;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待状态文件超时");
}

async function readStoredStatus(directory: string): Promise<string | undefined> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const name = names[0];
  if (!name) return undefined;
  try {
    return JSON.parse(await readFile(join(directory, name), "utf8")).status;
  } catch {
    return undefined;
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("groupAgentDirectories", () => {
  it("按完整目录分别去重，并允许同一目录同时出现在两组", () => {
    const records: AgentSessionPresence[] = [
      { version: 1, instanceId: "one", pid: 1, sessionId: "one", cwd: "/workspace/a", status: "idle", updatedAt: 1 },
      { version: 1, instanceId: "two", pid: 2, sessionId: "two", cwd: "/workspace/a", status: "idle", updatedAt: 1 },
      { version: 1, instanceId: "three", pid: 3, sessionId: "three", cwd: "/workspace/a", status: "working", updatedAt: 1 },
      { version: 1, instanceId: "four", pid: 4, sessionId: "four", cwd: "/workspace/b", status: "working", updatedAt: 1 },
    ];

    expect(groupAgentDirectories(records)).toEqual({
      idle: ["/workspace/a"],
      working: ["/workspace/a", "/workspace/b"],
    });
  });
});

describe("AgentSessionPresenceStore", () => {
  it("同步已加载 HUD 的会话状态，并在状态变化后更新分组", async () => {
    const directory = await createDirectory();
    const options = { directory, heartbeatMs: 60_000, pollMs: 60_000, isProcessAlive: () => true };
    const first = new AgentSessionPresenceStore(options);
    const second = new AgentSessionPresenceStore(options);
    first.start("first", "/workspace/idle", "idle");
    second.start("second", "/workspace/working", "working");

    await waitFor(async () => {
      await first.refresh();
      return first.getRecords().length === 2;
    });
    expect(groupAgentDirectories(first.getRecords())).toEqual({
      idle: ["/workspace/idle"],
      working: ["/workspace/working"],
    });

    second.setStatus("idle");
    await waitFor(async () => {
      await first.refresh();
      return groupAgentDirectories(first.getRecords()).working.length === 0;
    });
    expect(groupAgentDirectories(first.getRecords()).idle).toEqual(["/workspace/idle", "/workspace/working"]);

    await first.stop();
    await second.stop();
  });

  it("心跳重新计算状态，undefined 或抛错时保持原状态", async () => {
    const directory = await createDirectory();
    let resolved: "idle" | "working" | undefined = "idle";
    let shouldThrow = false;
    const store = new AgentSessionPresenceStore({
      directory,
      heartbeatMs: 10,
      pollMs: 60_000,
      isProcessAlive: () => true,
      resolveStatus: () => {
        if (shouldThrow) throw new Error("ctx stale");
        return resolved;
      },
    });
    store.start("heartbeat", "/workspace/heartbeat", "working");

    await waitFor(() => store.getRecords()[0]?.status === "idle");
    await waitFor(async () => (await readStoredStatus(directory)) === "idle");

    resolved = undefined;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRecords()[0]?.status).toBe("idle");

    resolved = "working";
    shouldThrow = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRecords()[0]?.status).toBe("idle");

    shouldThrow = false;
    await waitFor(() => store.getRecords()[0]?.status === "working");
    await store.stop();
  });

  it("忽略过期、已退出或损坏的状态文件", async () => {
    const directory = await createDirectory();
    await writeFile(join(directory, "broken.json"), "not-json");
    await writeFile(join(directory, "stale.json"), JSON.stringify({
      version: 1,
      instanceId: "stale",
      pid: 99,
      sessionId: "stale",
      cwd: "/workspace/stale",
      status: "working",
      updatedAt: 0,
    }));
    await writeFile(join(directory, "exited.json"), JSON.stringify({
      version: 1,
      instanceId: "exited",
      pid: 100,
      sessionId: "exited",
      cwd: "/workspace/exited",
      status: "working",
      updatedAt: 20_000,
    }));
    const store = new AgentSessionPresenceStore({
      directory,
      heartbeatMs: 60_000,
      pollMs: 60_000,
      now: () => 20_000,
      staleMs: 10_000,
      isProcessAlive: (pid) => pid !== 100,
    });
    store.start("current", "/workspace/current", "idle");

    await store.refresh();
    expect(store.getRecords().map((record) => record.cwd)).toEqual(["/workspace/current"]);
    await store.stop();
  });
});
