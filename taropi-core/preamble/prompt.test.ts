import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { hasFullSystemPromptOverride, replacePreambleInMessages } from "./prompt.ts";

function tool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  } as Tool;
}

function systemMessage(overrides: Partial<SystemMessage> = {}): SystemMessage {
  return {
    role: "system",
    content: "",
    sections: {
      preamble: "You are an expert coding assistant.",
      tools: "<tools>\n- read\n- write\n</tools>",
      rules: "<rules>\n- Use read\n</rules>",
      docs: "<docs>Pi documentation</docs>",
      skills: "<skills>fixture</skills>",
      project_context: "<project_context>fixture</project_context>",
      cwd: "<cwd>/fixture</cwd>",
    },
    toolsAdded: [tool("read"), tool("write")],
    timestamp: 0,
    ...overrides,
  };
}

describe("PREAMBLE 角色替换", () => {
  it("只替换角色区块，保留动态工具、规则和上下文", () => {
    const original: AgentMessage[] = [
      systemMessage(),
      { role: "user", content: "测试", timestamp: 1 },
      {
        role: "system",
        content: "",
        sections: {
          tools: "<tools>\n- read\n- web_search\n</tools>",
          rules: "<rules>\n- Use web_search\n</rules>",
        },
        toolsAdded: [tool("web_search")],
        toolsRemoved: [{ name: "write" }],
        timestamp: 2,
      },
    ];
    const snapshot = structuredClone(original);

    const replaced = replacePreambleInMessages(original, "你是一名专业编程助手。");
    const before = getCurrentSystemMessage(original)!;
    const after = getCurrentSystemMessage(replaced)!;

    expect(original).toEqual(snapshot);
    expect(after).toEqual({
      ...before,
      sections: { ...before.sections, preamble: "你是一名专业编程助手。" },
    });
    expect(getCurrentTools(replaced).map((item) => item.name)).toEqual(["read", "web_search"]);
    expect(getCurrentSystemPrompt(replaced)).toContain("<rules>\n- Use web_search\n</rules>");
    expect(getCurrentSystemPrompt(replaced)).toContain("<project_context>fixture</project_context>");
  });

  it("兼容后续系统消息的角色更新且重复处理幂等", () => {
    const messages: AgentMessage[] = [
      systemMessage(),
      systemMessage({ sections: { preamble: "A later role" }, toolsAdded: undefined, timestamp: 2 }),
    ];

    const once = replacePreambleInMessages(messages, "中文角色");
    const twice = replacePreambleInMessages(once, "中文角色");

    expect(once.filter((message) => message.role === "system").every((message) => message.sections?.preamble === "中文角色")).toBe(true);
    expect(twice).toBe(once);
  });

  it("缺少结构化角色区块时安全跳过", () => {
    const messages: AgentMessage[] = [systemMessage({ sections: { rules: "<rules>fixture</rules>" } })];
    expect(replacePreambleInMessages(messages, "中文角色")).toBe(messages);
  });

  it("完整覆盖优先于 PREAMBLE", () => {
    expect(hasFullSystemPromptOverride({})).toBe(false);
    expect(hasFullSystemPromptOverride({ customPrompt: "原生 SYSTEM.md" })).toBe(true);
    expect(hasFullSystemPromptOverride({ forceSystemPrompt: "强制提示词" })).toBe(true);
    expect(hasFullSystemPromptOverride({ forceSystemPrompt: "" })).toBe(true);
  });
});
