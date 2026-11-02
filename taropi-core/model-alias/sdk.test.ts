import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, InteractiveMode, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionUIContext, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./index.ts";
import { aliasStore } from "./store.ts";

const directories: string[] = [];
const MODEL_ID = "nested/new-default";

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  aliasStore.reload();
  vi.unstubAllEnvs();
});

describe("真实 AgentSession 默认模型联动回归（mock provider）", () => {
  it("Ag 绑定后同步当前 SettingsManager 和新扩展运行时，不切换当前模型或改写会话", async () => {
    const f = await fixture();
    try {
      await f.session.prompt("保留已有对话");
      const messages = structuredClone(f.session.messages);
      const entries = structuredClone(f.session.sessionManager.getEntries());
      const id = f.session.sessionManager.getSessionId();
      const tools = f.session.getActiveToolNames();
      await f.session.prompt(`/model-alias Ag alias-test/${MODEL_ID}`);
      expect(f.settings.getDefaultModel()).toBe(MODEL_ID);
      expect(f.settings.getDefaultProvider()).toBe("alias-test");
      expect(f.observedDefaults).toEqual(["old-default", MODEL_ID]);
      expect(aliasStore.get("Ag")).toBe(`alias-test/${MODEL_ID}`);
      expect(f.reloads()).toBe(1);
      expect(f.session.model?.id).toBe("current");
      expect(f.session.sessionManager.getSessionId()).toBe(id);
      expect(f.session.getActiveToolNames()).toEqual(tools);
      expect(f.session.messages).toEqual(messages);
      expect(f.session.sessionManager.getEntries()).toEqual(entries);
      expect(f.requests).toHaveLength(1);
      expect(f.notices.join("\n")).toContain("默认配置已保存，正在重新加载");
      expect(f.errors).toEqual([]);
    } finally { f.session.dispose(); }
  });

  it("原生 /model 选择器的 default 标记从旧模型移到 Ag 新模型", async () => {
    const f = await fixture();
    const themeKeys = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
    const savedThemes = themeKeys.map((key) => Reflect.get(globalThis, key));
    try {
      initTheme("dark", false);
      vi.spyOn(f.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
      const before = renderNativePicker(f.session, f.settings);
      expect(before.filter((line) => line.includes(" · default"))).toEqual([expect.stringContaining("old-default")]);
      await f.session.prompt(`/model-alias Ag alias-test/${MODEL_ID}`);
      const after = renderNativePicker(f.session, f.settings);
      expect(after.filter((line) => line.includes(" · default"))).toEqual([expect.stringContaining(MODEL_ID)]);
      expect(after.find((line) => line.includes("old-default"))).not.toContain(" · default");
      expect(f.errors).toEqual([]);
    } finally {
      f.session.dispose();
      for (const [index, key] of themeKeys.entries()) {
        if (savedThemes[index] === undefined) Reflect.deleteProperty(globalThis, key);
        else Reflect.set(globalThis, key, savedThemes[index]);
      }
    }
  });

  it("配置文件已更新但当前内存仍是旧模型时，重复绑定 Ag 也会重载刷新", async () => {
    const f = await fixture();
    try {
      const writer = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false });
      writer.setDefaultModelAndProvider("alias-test", MODEL_ID);
      await writer.flush();
      expect(f.settings.getDefaultModel()).toBe("old-default");
      await f.session.prompt(`/model-alias Ag alias-test/${MODEL_ID}`);
      expect(f.settings.getDefaultModel()).toBe(MODEL_ID);
      expect(f.observedDefaults.at(-1)).toBe(MODEL_ID);
      expect(f.reloads()).toBe(1);
      expect(f.session.model?.id).toBe("current");
      expect(f.requests).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { f.session.dispose(); }
  });

  it("TUI 选择 Ag 后也同步当前内存，重载后原会话继续聊天", async () => {
    const f = await fixture("tui");
    try {
      await f.session.prompt("TUI 绑定之前");
      await f.session.prompt("第二轮聊天");
      f.custom.mockResolvedValueOnce("Ag").mockResolvedValueOnce(`alias-test/${MODEL_ID}`);
      const messages = structuredClone(f.session.messages);
      await f.session.prompt("/model-alias");
      expect(f.settings.getDefaultModel()).toBe(MODEL_ID);
      expect(f.session.messages).toEqual(messages);
      expect(f.reloads()).toBe(1);
      await f.session.prompt("绑定之后继续");
      await f.session.prompt("第四轮聊天");
      expect(f.requests).toHaveLength(4);
      expect(f.session.model?.id).toBe("current");
      for (let i = 1; i < f.requests.length; i++) {
        const previous = f.requests[i - 1]!;
        expect(f.requests[i]!.slice(0, previous.length)).toEqual(previous);
      }
      expect(f.errors).toEqual([]);
    } finally { f.session.dispose(); }
  });

  it("Au/Cu 绑定不重载，也不修改当前内存默认模型", async () => {
    const f = await fixture();
    try {
      await f.session.prompt(`/model-alias Au alias-test/${MODEL_ID}`);
      await f.session.prompt(`/model-alias Cu alias-test/${MODEL_ID}`);
      expect(f.settings.getDefaultModel()).toBe("old-default");
      expect(f.reloads()).toBe(0);
      expect(f.observedDefaults).toEqual(["old-default"]);
      expect(f.errors).toEqual([]);
    } finally { f.session.dispose(); }
  });

  it("默认配置损坏时保存 Ag 但不重载，不覆盖坏文件或误报内存已同步", async () => {
    const f = await fixture();
    try {
      fs.writeFileSync(path.join(f.agentDir, "settings.json"), "{broken");
      await f.session.prompt(`/model-alias Ag alias-test/${MODEL_ID}`);
      expect(aliasStore.get("Ag")).toBe(`alias-test/${MODEL_ID}`);
      expect(f.settings.getDefaultModel()).toBe("old-default");
      expect(f.reloads()).toBe(0);
      expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf-8")).toBe("{broken");
      expect(f.notices.join("\n")).toContain("默认模型未同步");
      expect(f.notices.join("\n")).not.toContain("正在重新加载");
      expect(f.errors).toEqual([]);
    } finally { f.session.dispose(); }
  });
});

function renderNativePicker(session: Awaited<ReturnType<typeof createAgentSession>>["session"], settings: SettingsManager): string[] {
  let selector: ModelSelectorComponent | undefined;
  const native = InteractiveMode.prototype as unknown as { showModelSelector(): void };
  const host = {
    session, settingsManager: settings, ui: { requestRender: vi.fn() },
    showSelector: (create: (done: () => void) => { component: ModelSelectorComponent }) => {
      selector = create(() => undefined).component;
    },
  };
  native.showModelSelector.call(host);
  try { return selector!.render(120).map(stripTerminalSequences); }
  finally { selector!.dispose(); }
}

async function fixture(mode: "tui" | "rpc" = "rpc") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "alias-reload-sdk-"));
  directories.push(cwd);
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "alias-test", defaultModel: "old-default", defaultThinkingLevel: "low",
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  }));
  fs.writeFileSync(path.join(agentDir, "model-aliases.json"), JSON.stringify({ Ag: "alias-test/old-default" }));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const requests: Message[][] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const observedDefaults: (string | undefined)[] = [];
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  models.registerProvider("alias-test", {
    api: "anthropic-messages", apiKey: "test-key", baseUrl: "https://invalid.example",
    models: ["current", "old-default", MODEL_ID].map((id) => ({
      id, name: id, reasoning: true, input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
    })),
    streamSimple: (model, context) => {
      requests.push(structuredClone(context.messages));
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "收到" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  });
  const observe = (pi: ExtensionAPI): void => {
    pi.on("session_start", () => { observedDefaults.push(pi.getSettings().defaultModel); });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true, extensionFactories: [register, observe],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, model: models.getModel("alias-test", "current")!, modelRuntime: models, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), resourceLoader, tools: [],
  });
  const custom = vi.fn<ExtensionUIContext["custom"]>();
  const ui = { notify: (message: string) => { notices.push(message); }, custom } as unknown as ExtensionUIContext;
  let reloads = 0;
  await session.bindExtensions({
    mode, uiContext: ui, onError: (error) => { errors.push(error.error); },
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }),
      reload: async () => { await session.reload(); reloads++; },
    },
  });
  return { cwd, agentDir, session, settings, custom, requests, errors, notices, observedDefaults, reloads: () => reloads };
}
