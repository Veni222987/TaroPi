import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultModelSync } from "./default-sync.ts";
import { aliasStore } from "./store.ts";

let directory: string;
let settingsPath: string;
let aliasesPath: string;
let sync: DefaultModelSync;
let ctx: Pick<ExtensionContext, "cwd" | "ui">;
const notify = vi.fn();
const initialAliases = { Au: "qq/gold", Ag: "qq/silver", Cu: "qq/copper" };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-default-sync-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  settingsPath = path.join(directory, "settings.json");
  aliasesPath = path.join(directory, "model-aliases.json");
  fs.writeFileSync(aliasesPath, JSON.stringify(initialAliases));
  aliasStore.reload();
  sync = new DefaultModelSync();
  ctx = { cwd: directory, ui: { notify } as unknown as ExtensionContext["ui"] };
});

afterEach(() => {
  vi.restoreAllMocks();
  notify.mockReset();
  fs.rmSync(directory, { recursive: true, force: true });
  aliasStore.reload();
  vi.unstubAllEnvs();
});

describe("默认模型与 Ag 联动", () => {
  it("首次读取和启动仅记录基线，已有默认模型与 Ag 不一致也不对齐", async () => {
    writeSettings("default");
    const before = fs.readFileSync(settingsPath, "utf-8");
    await sync.syncAgFromDefault(ctx);
    await sync.syncAgFromDefault(ctx);
    await sync.initialize(ctx);
    expect(aliasStore.getAll()).toEqual(initialAliases);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it("默认模型变化时 Ag 跟随，并保留其他进程刚修改的 Au/Cu", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    fs.writeFileSync(aliasesPath, JSON.stringify({ ...initialAliases, Au: "qq/new-gold" }));
    writeSettings("cursor/grok-4.7@500k", "magpie");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.getAll()).toEqual({ ...initialAliases, Au: "qq/new-gold", Ag: "magpie/cursor/grok-4.7@500k" });
    expect(JSON.parse(fs.readFileSync(aliasesPath, "utf-8"))).toEqual(aliasStore.getAll());
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ag 已跟随"), "info");
    await sync.syncAgFromDefault(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("默认模型已与 Ag 相同则不重复保存或通知", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    writeSettings("silver");
    const set = vi.spyOn(aliasStore, "set");
    await sync.syncAgFromDefault(ctx);
    await sync.syncAgFromDefault(ctx);
    expect(set).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("Ag 变化时仅修改全局默认模型字段，不改项目配置或其他全局字段", async () => {
    writeSettings("default", "qq", { theme: "light", compaction: { enabled: false }, packages: ["local-package"] });
    fs.mkdirSync(path.join(directory, ".pi"));
    const projectPath = path.join(directory, ".pi", "settings.json");
    const project = JSON.stringify({ defaultProvider: "project", defaultModel: "override" });
    fs.writeFileSync(projectPath, project);
    await sync.initialize(ctx);
    aliasStore.set("Ag", "magpie/cursor/grok-4.7@500k");
    expect(await sync.syncDefaultFromAg(ctx, { provider: "magpie", id: "cursor/grok-4.7@500k" })).toBe(true);
    expect(readSettings()).toEqual({ defaultProvider: "magpie", defaultModel: "cursor/grok-4.7@500k", theme: "light", compaction: { enabled: false }, packages: ["local-package"] });
    expect(fs.readFileSync(projectPath, "utf-8")).toBe(project);
    await sync.syncAgFromDefault(ctx);
    expect(notify).not.toHaveBeenCalled();
  });

  it("项目默认模型变化不参与全局联动", async () => {
    writeSettings("default");
    fs.mkdirSync(path.join(directory, ".pi"));
    fs.writeFileSync(path.join(directory, ".pi", "settings.json"), "{broken");
    await sync.initialize(ctx);
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.getAll()).toEqual(initialAliases);
    expect(notify).not.toHaveBeenCalled();
  });

  it("Ag 与默认模型已经一致则不重复写入", async () => {
    writeSettings("silver");
    const setDefault = vi.spyOn(SettingsManager.prototype, "setDefaultModelAndProvider");
    expect(await sync.syncDefaultFromAg(ctx, { provider: "qq", id: "silver" })).toBe(true);
    expect(setDefault).not.toHaveBeenCalled();
  });

  it("恢复会话重新记录基线，不对齐恢复前的变更", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    writeSettings("other");
    await sync.initialize(ctx);
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.getAll()).toEqual(initialAliases);
    writeSettings("next");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).toBe("qq/next");
  });

  it("读写操作串行，Ag 写入后不会被同时发起的反向检查覆盖", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    aliasStore.set("Ag", "qq/new-silver");
    await Promise.all([
      sync.syncDefaultFromAg(ctx, { provider: "qq", id: "new-silver" }),
      sync.syncAgFromDefault(ctx),
      sync.syncAgFromDefault(ctx),
    ]);
    expect(aliasStore.get("Ag")).toBe("qq/new-silver");
    expect(readSettings().defaultModel).toBe("new-silver");
    expect(notify).not.toHaveBeenCalled();
  });

  it("settings 缺失不创建文件，之后设置默认模型仍然会跟随", async () => {
    await sync.initialize(ctx);
    await sync.syncAgFromDefault(ctx);
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(aliasStore.getAll()).toEqual(initialAliases);
    writeSettings("new");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).toBe("qq/new");
  });

  it("settings 缺失时，显式绑定 Ag 可以创建默认配置", async () => {
    expect(await sync.syncDefaultFromAg(ctx, { provider: "qq", id: "silver" })).toBe(true);
    expect(readSettings()).toEqual({ defaultProvider: "qq", defaultModel: "silver" });
  });

  it("移除默认模型字段不清除 Ag，之后重新设置仍然会跟随", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    fs.writeFileSync(settingsPath, "{}");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.getAll()).toEqual(initialAliases);
    writeSettings("new");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).toBe("qq/new");
  });

  it.each(["{broken", "null", "[]", '{"defaultProvider":"qq","defaultModel":42}', '{"defaultProvider":"qq/nested","defaultModel":"x"}', '{"defaultProvider":"qq","defaultModel":"has space"}'])(
    "settings 损坏或字段无效时告警，不覆盖文件或 Ag: %s",
    async (text) => {
      fs.writeFileSync(settingsPath, text);
      await sync.initialize(ctx);
      await sync.syncAgFromDefault(ctx);
      expect(await sync.syncDefaultFromAg(ctx, { provider: "qq", id: "new-silver" })).toBe(false);
      expect(fs.readFileSync(settingsPath, "utf-8")).toBe(text);
      expect(aliasStore.getAll()).toEqual(initialAliases);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("无法读取全局默认模型"), "warning");
    },
  );

  it("读取失败后保留旧基线，修复文件后可继续跟随", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    fs.writeFileSync(settingsPath, "{broken");
    await sync.syncAgFromDefault(ctx);
    writeSettings("new");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).toBe("qq/new");
  });

  it("首次读取失败后，首次成功读取仍只建立基线", async () => {
    fs.writeFileSync(settingsPath, "{broken");
    await sync.initialize(ctx);
    writeSettings("new");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.getAll()).toEqual(initialAliases);
  });

  it("SDK flush 抑制的写入错误也会被报告，不把未写入当作成功", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    aliasStore.set("Ag", "qq/new-silver");
    const failingSettings = SettingsManager.fromStorage({
      withLock: (_scope, operation) => {
        if (operation(JSON.stringify(readSettings())) !== undefined) throw new Error("模拟写入失败");
      },
    }, { projectTrusted: false });
    vi.spyOn(SettingsManager, "create").mockReturnValueOnce(failingSettings);
    expect(await sync.syncDefaultFromAg(ctx, { provider: "qq", id: "new-silver" })).toBe(false);
    expect(readSettings().defaultModel).toBe("default");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("默认模型同步失败"), "warning");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).toBe("qq/new-silver");
    expect(await sync.syncDefaultFromAg(ctx, { provider: "qq", id: "new-silver" })).toBe(true);
  });

  it("别名写入失败保留基线，下次检查可以重试", async () => {
    writeSettings("default");
    await sync.initialize(ctx);
    fs.unlinkSync(aliasesPath);
    fs.mkdirSync(aliasesPath);
    writeSettings("new");
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).not.toBe("qq/new");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ag 同步失败"), "warning");
    fs.rmdirSync(aliasesPath);
    fs.writeFileSync(aliasesPath, JSON.stringify(initialAliases));
    await sync.syncAgFromDefault(ctx);
    expect(aliasStore.get("Ag")).toBe("qq/new");
  });

  it("store 写入失败不会提前更新内存中的绑定", () => {
    fs.unlinkSync(aliasesPath);
    fs.mkdirSync(aliasesPath);
    expect(() => aliasStore.set("Ag", "qq/new")).toThrow();
    expect(aliasStore.getAll()).toEqual(initialAliases);
  });
});

function writeSettings(modelId: string, provider = "qq", extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(settingsPath, JSON.stringify({ ...extra, defaultProvider: provider, defaultModel: modelId }));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
}
