import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAsk } from "./index.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ask-sdk-")); directories.push(cwd);
	const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
	const requests: { messages: Message[] }[] = [];
	const prefixErrors: unknown[] = [];
	const errors: string[] = [];
	const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("ask-test", {
		api: "anthropic-messages", apiKey: "test-key", baseUrl: "https://invalid.example",
		models: [{ id: "asker", name: "asker", reasoning: true, input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (_model, context) => {
			const messages = structuredClone(context.messages);
			if (requests.length && requests[0]!.messages.length) {
				try {
					const first = requests[0]!.messages;
					if (messages.length >= first.length) expect(messages.slice(0, first.length)).toEqual(first);
				} catch (error) { prefixErrors.push(error); }
			}
			requests.push({ messages });
			const response: AssistantMessage = {
				role: "assistant", api: "anthropic-messages", provider: "ask-test", model: "asker",
				content: [{ type: "text", text: "收到" }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: response }));
			return stream;
		},
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	const sessionManager = SessionManager.inMemory(cwd);
	const model = runtime.getModel("ask-test", "asker")!;
	const ui = { notify: vi.fn(), select: vi.fn(), input: vi.fn() } as unknown as ExtensionUIContext;
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [registerAsk] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, settingsManager,
		sessionManager, resourceLoader, tools: [], thinkingLevel: "off" });
	await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: (error) => { errors.push(error.error); } });
	return { session, requests, sessionManager, prefixErrors, errors };
}

describe("/ask 真实会话：原始输入与注入提示词分离", () => {
	it("聊天与历史只存原始输入，模型请求收到注入提示词且历史只追加", async () => {
		const f = await fixture(); const session = f.session as AgentSession;
		try {
			await session.prompt("/ask 为什么这样"); await session.waitForIdle();
			await session.prompt("普通问题"); await session.waitForIdle();

			const customEntries = f.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "taropi-ask");
			expect(customEntries).toHaveLength(1);
			expect(customEntries[0]).toMatchObject({ display: true, details: { input: "/ask 为什么这样" } });
			const userEntries = f.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user");
			expect(JSON.stringify(userEntries)).not.toContain("请先查证");

			expect(f.requests).toHaveLength(2);
			const first = f.requests[0]!.messages.at(-1);
			expect(first).toMatchObject({ role: "user" });
			const firstText = typeof first!.content === "string" ? first!.content : first!.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			expect(firstText).toContain("请先查证");
			expect(firstText).toContain("为什么这样");
			expect(JSON.stringify(f.requests[1]!.messages.slice(0, f.requests[0]!.messages.length))).toBe(JSON.stringify(f.requests[0]!.messages));
			expect(f.prefixErrors).toEqual([]);
			expect(f.errors).toEqual([]);
		} finally { session.dispose(); }
	}, 15000);
});
