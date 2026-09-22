import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./index.ts";

type RegisteredHandler = (...args: unknown[]) => unknown;

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-preamble-index-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  fs.writeFileSync(path.join(tempDir, "PREAMBLE.md"), "首次角色");
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setup(): {
  handlers: Map<string, RegisteredHandler>;
  notifications: string[];
} {
  const handlers = new Map<string, RegisteredHandler>();
  const notifications: string[] = [];
  const pi = {
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler as RegisteredHandler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  register(pi);
  return { handlers, notifications };
}

function context(notifications: string[]): unknown {
  return {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  };
}

function messages(): AgentMessage[] {
  return [{
    role: "system",
    content: "",
    sections: { preamble: "Pi 默认角色", tools: "<tools>动态工具</tools>" },
    timestamp: 0,
  }];
}

describe("PREAMBLE 运行时模块", () => {
  it("会话启动后刷新缓存，普通请求沿用当前缓存", () => {
    const { handlers, notifications } = setup();
    const ctx = context(notifications);
    const before = handlers.get("before_agent_start")!;
    const withSystem = handlers.get("context_with_system")!;
    const options = { cwd: "/fixture", customPrompt: undefined, forceSystemPrompt: undefined };

    before({ systemPromptOptions: options }, ctx);
    const first = withSystem({ messages: messages() }, ctx) as { messages: AgentMessage[] };
    expect(first.messages[0]!.role === "system" && first.messages[0].sections?.preamble).toBe("首次角色");

    fs.writeFileSync(path.join(tempDir, "PREAMBLE.md"), "刷新后的角色");
    const cached = withSystem({ messages: messages() }, ctx) as { messages: AgentMessage[] };
    expect(cached.messages[0]!.role === "system" && cached.messages[0].sections?.preamble).toBe("首次角色");

    handlers.get("session_start")!({}, ctx);
    before({ systemPromptOptions: options }, ctx);
    const refreshed = withSystem({ messages: messages() }, ctx) as { messages: AgentMessage[] };
    expect(refreshed.messages[0]!.role === "system" && refreshed.messages[0].sections?.preamble).toBe("刷新后的角色");
  });

  it("后续 Hook 设置完整覆盖时跳过角色替换并仅提示一次", () => {
    const { handlers, notifications } = setup();
    const ctx = context(notifications);
    const before = handlers.get("before_agent_start")!;
    const withSystem = handlers.get("context_with_system")!;
    const options = { cwd: "/fixture", customPrompt: undefined, forceSystemPrompt: undefined as string | undefined };

    before({ systemPromptOptions: options }, ctx);
    options.forceSystemPrompt = "后续 Hook 的完整提示词";

    expect(withSystem({ messages: messages() }, ctx)).toBeUndefined();
    expect(withSystem({ messages: messages() }, ctx)).toBeUndefined();
    expect(notifications).toEqual(["检测到 Pi 完整系统提示词覆盖，已跳过 PREAMBLE.md 角色替换。"]);
  });

  it("在无 UI 模式将冲突提示写入 stderr", () => {
    const { handlers } = setup();
    const before = handlers.get("before_agent_start")!;
    const withSystem = handlers.get("context_with_system")!;
    const options = { cwd: "/fixture", customPrompt: "原生完整提示词", forceSystemPrompt: undefined };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    before({ systemPromptOptions: options }, { hasUI: false });
    withSystem({ messages: messages() }, { hasUI: false });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("已跳过 PREAMBLE.md 角色替换"));
    write.mockRestore();
  });
});
