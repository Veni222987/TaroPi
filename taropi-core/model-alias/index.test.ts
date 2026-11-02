import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./index.ts";
import { aliasStore } from "./store.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Hook = (event: unknown, ctx: ExtensionContext) => unknown;

let directory: string;
let settingsPath: string;
let ctx: ExtensionCommandContext;
let command: Command;
const hooks = new Map<string, Hook>();
const notify = vi.fn();
const custom = vi.fn();
const reload = vi.fn(async () => undefined);
const available = vi.fn(() => [
  { provider: "qq", id: "default", name: "Default" },
  { provider: "magpie", id: "cursor/grok-4.7@500k", name: "Grok" },
]);
const api = {
  on: vi.fn((event: string, handler: Hook) => { hooks.set(event, handler); }),
  registerCommand: vi.fn((_name: string, registered: Command) => registered),
  setModel: vi.fn(), setActiveTools: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(), sendUserMessage: vi.fn(),
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-alias-command-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  settingsPath = path.join(directory, "settings.json");
  writeDefault("default");
  fs.writeFileSync(path.join(directory, "model-aliases.json"), JSON.stringify({ Ag: "qq/silver" }));
  ctx = { cwd: directory, mode: "print", ui: { notify, custom }, modelRegistry: { getAvailable: available }, reload } as unknown as ExtensionCommandContext;
  register(api as unknown as ExtensionAPI);
  command = api.registerCommand.mock.calls[0]![1];
  await emit("session_start");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  custom.mockReset();
  hooks.clear();
  fs.rmSync(directory, { recursive: true, force: true });
  aliasStore.reload();
  vi.unstubAllEnvs();
});

describe("模型别名命令与联动触发", () => {
  it("只注册配置检查钩子，不新增 rename，不改模型、上下文或工具列表", async () => {
    expect(api.registerCommand.mock.calls.map(([name]) => name)).toEqual(["model-alias"]);
    expect([...hooks.keys()]).toEqual(["session_start", "model_select", "input"]);
    expect(await emit("input")).toBeUndefined();
    for (const method of [api.setModel, api.setActiveTools, api.appendEntry, api.sendMessage, api.sendUserMessage]) expect(method).not.toHaveBeenCalled();
  });

  it("临时切换当前模型不改变默认模型或 Ag", async () => {
    await emit("model_select", { source: "set", model: { provider: "magpie", id: "cursor/grok-4.7@500k" } });
    expect(aliasStore.get("Ag")).toBe("qq/silver");
    expect(readDefault()).toBe("default");
    expect(notify).not.toHaveBeenCalled();
  });

  it("model_select 能检测 Pi 排队写入的默认模型", async () => {
    const settings = SettingsManager.create(directory, directory);
    settings.setDefaultModelAndProvider("magpie", "cursor/grok-4.7@500k");
    await emit("model_select");
    await settings.flush();
    expect(aliasStore.get("Ag")).toBe("magpie/cursor/grok-4.7@500k");
  });

  it("对当前模型保存默认而没有 model_select，下次输入时补同步", async () => {
    writeDefault("new");
    expect(await emit("input")).toBeUndefined();
    expect(aliasStore.get("Ag")).toBe("qq/new");
  });

  it("命令执行前先检测默认模型变化，即使只查询档位也能跟随", async () => {
    writeDefault("new");
    await command.handler("Ag", ctx);
    expect(aliasStore.get("Ag")).toBe("qq/new");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("qq/new"), "info");
  });

  it("参数模式绑定 Ag 后同步默认模型，保留 registry 的真实大小写和嵌套 id", async () => {
    await command.handler("Argentum MAGPIE/CURSOR/GROK-4.7@500K", ctx);
    expect(aliasStore.get("Ag")).toBe("magpie/cursor/grok-4.7@500k");
    expect(readDefault()).toBe("cursor/grok-4.7@500k");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("默认配置已保存，正在重新加载"), "info");
    expect(reload).toHaveBeenCalledTimes(1);
    await emit("input");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each(["Au", "Cu"])("绑定 %s 不改变默认模型", async (tier) => {
    await command.handler(`${tier} magpie/cursor/grok-4.7@500k`, ctx);
    expect(readDefault()).toBe("default");
    expect(aliasStore.get("Ag")).toBe("qq/silver");
    expect(reload).not.toHaveBeenCalled();
  });

  it("TUI 模式也通过共同绑定路径更新 Ag 和默认模型", async () => {
    ctx.mode = "tui";
    custom.mockResolvedValueOnce("Ag").mockResolvedValueOnce("magpie/cursor/grok-4.7@500k");
    await command.handler("", ctx);
    expect(aliasStore.get("Ag")).toBe("magpie/cursor/grok-4.7@500k");
    expect(readDefault()).toBe("cursor/grok-4.7@500k");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("默认配置已保存，正在重新加载"), "info");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("默认配置已经一致时仍重载，使旧运行时内存读到最新默认模型", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "magpie", defaultModel: "cursor/grok-4.7@500k" }));
    await command.handler("Ag magpie/cursor/grok-4.7@500k", ctx);
    await command.handler("Ag magpie/cursor/grok-4.7@500k", ctx);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reload 失败向上传递错误，通知只说明保存配置，且不再操作旧 ctx", async () => {
    reload.mockRejectedValueOnce(new Error("模拟 reload 失败"));
    await expect(command.handler("Ag magpie/cursor/grok-4.7@500k", ctx)).rejects.toThrow("模拟 reload 失败");
    expect(aliasStore.get("Ag")).toBe("magpie/cursor/grok-4.7@500k");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("正在重新加载"), "info");
  });

  it("TUI 中取消或选择后模型已不可用则不绑定", async () => {
    ctx.mode = "tui";
    custom.mockResolvedValueOnce(null);
    await command.handler("", ctx);
    custom.mockResolvedValueOnce("Ag").mockResolvedValueOnce("unknown/missing");
    await command.handler("", ctx);
    expect(aliasStore.get("Ag")).toBe("qq/silver");
    expect(readDefault()).toBe("default");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("未匹配到模型"), "error");
  });

  it("绑定 Ag 时默认配置损坏，只保存别名并明确提示未同步", async () => {
    fs.writeFileSync(settingsPath, "{broken");
    await command.handler("Ag magpie/cursor/grok-4.7@500k", ctx);
    expect(aliasStore.get("Ag")).toBe("magpie/cursor/grok-4.7@500k");
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe("{broken");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("默认模型未同步"), "info");
    expect(reload).not.toHaveBeenCalled();
  });

  it("别名绑定写入失败不更新默认模型", async () => {
    const aliasesPath = path.join(directory, "model-aliases.json");
    fs.unlinkSync(aliasesPath);
    fs.mkdirSync(aliasesPath);
    await command.handler("Ag magpie/cursor/grok-4.7@500k", ctx);
    expect(readDefault()).toBe("default");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("绑定失败"), "error");
    expect(reload).not.toHaveBeenCalled();
  });

  it("无效格式和未知模型不产生绑定", async () => {
    await command.handler("Ag grok", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("格式无效"), "error");
    await command.handler("Ag qq/gpt-5/preview", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("未匹配到模型"), "error");
    expect(aliasStore.get("Ag")).toBe("qq/silver");
    expect(readDefault()).toBe("default");
  });
});

async function emit(name: string, event: unknown = {}): Promise<unknown> {
  return hooks.get(name)!(event, ctx);
}

function writeDefault(modelId: string): void {
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "qq", defaultModel: modelId }));
}

function readDefault(): unknown {
  return (JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>).defaultModel;
}
