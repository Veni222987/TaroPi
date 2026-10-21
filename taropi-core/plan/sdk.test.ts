import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configModule from "./config.ts";
import { findActivePlan } from "./file.ts";
import registerPlan from "./index.ts";

vi.mock("../model-alias/store.ts", () => ({ resolveModelAlias: () => undefined }));
const directories: string[] = [];
const PLAN = "目标：验证三态\n关键依据：SDK\nPlan:\n计划标题：缓存回归\n1. 写入实现\n风险：无";
const originalConfig = configModule.loadPlanConfig;
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture(cancelCompaction = false) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sdk-")); directories.push(cwd);
	const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
	const configPath = path.join(agentDir, "plan.json");
	fs.writeFileSync(configPath, JSON.stringify({ planning: { model: "plan-test/planner" }, implementing: { model: "plan-test/implementer" } }));
	vi.spyOn(configModule, "loadPlanConfig").mockImplementation(() => originalConfig(configPath));
	const requests: { model: string; messages: Message[] }[] = [];
	let previous: Message[] = [];
	let previousModel: string | undefined;
	let compactCount = 0;
	let startedAbort: (() => void) | undefined;
	const abortStarted = new Promise<void>((resolve) => { startedAbort = resolve; });
	const errors: string[] = [];
	const prefixErrors: unknown[] = [];
	const notifications: string[] = [];
	const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("plan-test", {
		api: "anthropic-messages", apiKey: "test-key", baseUrl: "https://invalid.example",
		models: ["planner", "implementer", "manual"].map((id) => ({ id, name: id, reasoning: true, input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
		streamSimple: (model, context, options) => {
			const messages = structuredClone(context.messages);
			if (previous.length && previousModel === model.id) {
				try {
					expect(messages.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
					expect(messages[previous.length - 1]).toMatchObject(previous.at(-1)!);
				} catch (error) { prefixErrors.push(error); }
			}
			requests.push({ model: model.id, messages });
			const step = requests.length;
			const last = messages.at(-1);
			const userText = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")) : "";
			let call: ToolCall | undefined;
			if (userText.includes("当前阶段：planning")) call = { type: "toolCall", id: `blocked-${step}`, name: "write", arguments: { path: "implementation.txt", content: "不应写入" } };
			else if (userText === "提交计划" || userText === "重新提交") call = { type: "toolCall", id: `submit-${step}`, name: "plan", arguments: { action: "submit", text: PLAN } };
			else if (userText.includes("当前阶段：implementing")) call = { type: "toolCall", id: `write-${step}`, name: "write", arguments: { path: "implementation.txt", content: "已实施" } };
			else if (last?.role === "toolResult" && last.toolName === "write" && !last.isError) call = { type: "toolCall", id: `complete-${step}`, name: "plan", arguments: { action: "complete", text: "实现完成，校验通过，无遗留风险" } };
			else if (userText === "退出 plan") call = { type: "toolCall", id: `exit-${step}`, name: "plan", arguments: { action: "exit" } };
			const response: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "thinking", thinking: "测试思考", thinkingSignature: `signature-${step}` }, ...(call ? [call] : [{ type: "text" as const, text: "收到" }])],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				if (userText === "中断测试") {
					startedAbort?.();
					const cancel = (): void => {
						const aborted = { ...response, stopReason: "aborted" as const, errorMessage: "用户中断" };
						// Pi 自身不重放 aborted assistant，仍要求中断前请求的历史前缀保持不变。
						previous = messages;
						stream.push({ type: "error", reason: "aborted", error: aborted });
					};
					if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener("abort", cancel, { once: true });
					return;
				}
				previous = [...messages, structuredClone(response)]; previousModel = model.id;
				stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: response });
			});
			return stream;
		},
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false }, cacheWarming: "off" });
	const sessionManager = SessionManager.inMemory(cwd);
	const model = runtime.getModel("plan-test", "planner")!;
	const ui = {
		notify: (message: string) => { notifications.push(message); },
		select: vi.fn(async () => "开始实施" as string | undefined), input: vi.fn(async () => "补充失败降级"),
	} as unknown as ExtensionUIContext;
	const compactionExtension = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => {
			compactCount++;
			if (cancelCompaction) return { cancel: true };
			previous = [];
			return { compaction: { summary: "已确认计划，执行第一步", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	};
	async function open(selectedModel = model): Promise<AgentSession> {
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
			noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [registerPlan, compactionExtension] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, model: selectedModel, modelRuntime: runtime, settingsManager,
			sessionManager, resourceLoader, tools: ["read", "bash", "edit", "write", "plan"], thinkingLevel: "medium" });
		await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: (error) => { errors.push(error.error); } });
		return session;
	}
	return { open, runtime, cwd, sessionManager, requests, errors, prefixErrors, notifications, ui, abortStarted, compactCount: () => compactCount };
}

async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
	throw new Error("等待实施自动启动超时");
}

describe("真实 AgentSession 缓存与恢复回归", () => {
	it("阶段内只追加；拒绝写入、abort、补充后继续；确认后只压缩和切模型一次", async () => {
		const f = await fixture(); const session = await f.open();
		try {
			const tools = session.getActiveToolNames();
			expect(tools).toContain("plan");
			await session.prompt("已有对话"); await session.prompt("/plan 修复缓存"); await session.waitForIdle();
			expect(fs.existsSync(path.join(f.cwd, "implementation.txt"))).toBe(false);
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())?.file.metadata.status).toBe("planning");
			const pending = session.prompt("中断测试"); await f.abortStarted; await session.abort(); await pending;
			await session.prompt("中断后继续");
			await session.setModel(f.runtime.getModel("plan-test", "manual")!);
			await session.prompt("换模型后继续"); expect(session.model?.id).toBe("manual");
			vi.mocked(f.ui.select).mockResolvedValueOnce("补充内容");
			await session.prompt("提交计划"); await session.waitForIdle();
			expect(session.messages.at(-1)).not.toMatchObject({ stopReason: "error" });
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())?.file.metadata.adjustmentRounds).toBe(1);
			await session.prompt("重新提交");
			await eventually(() => findActivePlan(f.cwd, f.sessionManager.getSessionId()) === undefined && fs.existsSync(path.join(f.cwd, "implementation.txt")));
			await session.waitForIdle(); await session.prompt("普通任务");
			expect(fs.readFileSync(path.join(f.cwd, "implementation.txt"), "utf8")).toBe("已实施");
			expect(f.compactCount()).toBe(1);
			expect(session.model?.id).toBe("implementer"); expect(session.getActiveToolNames()).toEqual(tools);
			const implementationPrompts = f.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("当前阶段：implementing"));
			expect(implementationPrompts).toHaveLength(1);
			const changes = f.sessionManager.getEntries().filter((entry) => entry.type === "model_change" && entry.modelId === "implementer");
			expect(changes).toHaveLength(1);
			for (const request of f.requests) expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
			expect(f.sessionManager.getEntries().filter((entry) => entry.type === "custom" || entry.type === "custom_message" || entry.type === "context_edit")).toEqual([]);
			expect(f.prefixErrors).toEqual([]);
			expect(f.errors).toEqual([]);
		} finally { session.dispose(); }
	}, 15000);
	it("重建 AgentSession 从 Markdown 恢复，保持手动模型且不自动发请求，自然语言退出", async () => {
		const f = await fixture(); let session = await f.open();
		try {
			await session.prompt("/plan 可恢复任务"); await session.waitForIdle();
			await session.setModel(f.runtime.getModel("plan-test", "manual")!);
			const model = session.model!; const count = f.requests.length;
			session.dispose(); session = await f.open(model);
			expect(f.requests).toHaveLength(count);
			expect(f.notifications.join("\n")).toContain("已恢复 plan：计划中");
			expect(session.model?.id).toBe("manual");
			await session.prompt("恢复后继续"); await session.prompt("退出 plan");
			expect(session.messages.at(-1)).not.toMatchObject({ stopReason: "error" });
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())).toBeUndefined();
			expect(session.model?.id).toBe("manual"); expect(f.compactCount()).toBe(0);
			expect(f.prefixErrors).toEqual([]);
			expect(f.errors).toEqual([]);
		} finally { session.dispose(); }
	}, 15000);
	it("确认后取消压缩并重建会话，待启动状态仅在下一次用户输入补发实施规则", async () => {
		const f = await fixture(true); let session = await f.open();
		try {
			await session.prompt("/plan 待启动恢复"); await session.waitForIdle();
			await session.prompt("提交计划");
			await eventually(() => f.compactCount() === 1 && session.isIdle);
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())?.file.metadata).toMatchObject({ status: "implementing", pendingLaunch: true });
			expect(fs.existsSync(path.join(f.cwd, "implementation.txt"))).toBe(false);
			const count = f.requests.length; const model = session.model!;
			session.dispose(); session = await f.open(model);
			expect(f.requests).toHaveLength(count);
			await session.prompt("继续实施"); await session.waitForIdle();
			expect(fs.readFileSync(path.join(f.cwd, "implementation.txt"), "utf8")).toBe("已实施");
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())).toBeUndefined();
			expect(f.compactCount()).toBe(1);
			expect(f.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("当前阶段：implementing"))).toHaveLength(1);
			expect(f.prefixErrors).toEqual([]); expect(f.errors).toEqual([]);
		} finally { session.dispose(); }
	}, 15000);
});
