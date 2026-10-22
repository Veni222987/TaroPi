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

async function fixture(cancelCompaction = false, pauseTitle = false) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sdk-")); directories.push(cwd);
	const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
	const configPath = path.join(agentDir, "plan.json");
	fs.writeFileSync(configPath, JSON.stringify({ planning: { model: "plan-test/planner" }, implementing: { model: "plan-test/implementer" } }));
	vi.spyOn(configModule, "loadPlanConfig").mockImplementation(() => originalConfig(configPath));
	const requests: { model: string; messages: Message[] }[] = [];
	const titleRequests: { model: string; messages: Message[] }[] = [];
	let finishTitle: (() => void) | undefined;
	let previous: Message[] = [];
	let previousModel: string | undefined;
	let compactCount = 0;
	let startedAbort: (() => void) | undefined;
	const abortStarted = new Promise<void>((resolve) => { startedAbort = resolve; });
	const errors: string[] = [];
	const prefixErrors: unknown[] = [];
	const notifications: string[] = [];
	const restoredDrafts: string[] = [];
	const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("plan-test", {
		api: "anthropic-messages", apiKey: "test-key", baseUrl: "https://invalid.example",
		models: ["planner", "implementer", "manual"].map((id) => ({ id, name: id, reasoning: true, input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
		streamSimple: (model, context, options) => {
			const messages = structuredClone(context.messages);
			if (messages.some((message) => message.role === "system" && JSON.stringify(message).includes("为任务生成简短文件名标题"))) {
				titleRequests.push({ model: model.id, messages });
				const response: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text", text: "缓存计划" }], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = createAssistantMessageEventStream();
				const finish = (): void => stream.push({ type: "done", reason: "stop", message: response });
				if (pauseTitle) finishTitle = finish; else queueMicrotask(finish);
				return stream;
			}
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
			else if (userText === "提交计划" || userText === "重新提交" || userText === "批量提交") call = { type: "toolCall", id: `submit-${step}`, name: "plan", arguments: { action: "submit", text: PLAN } };
			else if (userText.includes("当前阶段：implementing")) call = { type: "toolCall", id: `write-${step}`, name: "write", arguments: { path: "implementation.txt", content: "已实施" } };
			else if (last?.role === "toolResult" && last.toolName === "write" && !last.isError) call = { type: "toolCall", id: `complete-${step}`, name: "plan", arguments: { action: "complete", text: "实现完成，校验通过，无遗留风险" } };
			else if (userText === "退出 plan") call = { type: "toolCall", id: `exit-${step}`, name: "plan", arguments: { action: "exit" } };
			const calls = call ? [call] : [];
			if (userText === "批量提交") {
				calls.unshift({ type: "toolCall", id: `read-${step}`, name: "read", arguments: { path: "context.txt" } });
				calls.push({ type: "toolCall", id: `late-write-${step}`, name: "write", arguments: { path: "unexpected.txt", content: "不得执行" } });
			}
			const response: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "thinking", thinking: "测试思考", thinkingSignature: `signature-${step}` }, ...(call ? calls : [{ type: "text" as const, text: "收到" }])],
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
		select: vi.fn<ExtensionUIContext["select"]>((title, _choices, options) => {
			if (!title.startsWith("正在概括")) return Promise.resolve("开始实施");
			return new Promise((resolve) => {
				if (options?.signal?.aborted) resolve(undefined);
				else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		}), input: vi.fn(async () => "补充失败降级"),
	} as unknown as ExtensionUIContext;
	const compactionExtension = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => {
			compactCount++;
			if (cancelCompaction) return { cancel: true };
			previous = [];
			return { compaction: { summary: "已确认计划，执行第一步", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	};
	async function open(selectedModel = model, restoreQueues = false): Promise<AgentSession> {
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
			noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [registerPlan, compactionExtension] });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, model: selectedModel, modelRuntime: runtime, settingsManager,
			sessionManager, resourceLoader, tools: ["read", "bash", "edit", "write", "plan"], thinkingLevel: "medium" });
		await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: (error) => { errors.push(error.error); },
			abortHandler: restoreQueues ? () => {
				const { steering, followUp } = session.clearQueue();
				restoredDrafts.push([...steering, ...followUp].join("\n\n"));
				void session.abort();
			} : undefined,
		});
		return session;
	}
	return { open, runtime, cwd, sessionManager, requests, titleRequests, finishTitle: () => finishTitle?.(), errors, prefixErrors, notifications, restoredDrafts, ui, abortStarted, compactCount: () => compactCount };
}

async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
	throw new Error("等待实施自动启动超时");
}

describe("真实 AgentSession 缓存与恢复回归", () => {
	it("多轮讨论后用指代参数 /plan，标题请求读取实际任务，submit 改名不改写历史", async () => {
		const f = await fixture(); const session = await f.open();
		try {
			await session.prompt("企业微信 /fs 改为 /rs 原地续接已有会话");
			await session.prompt("本机和企业微信需要跨进程占用协调");
			const before = structuredClone(session.messages);
			await session.prompt("/plan 可以的，按照这个方式，输出计划"); await session.waitForIdle();
			const data = JSON.stringify(f.titleRequests[0]!.messages);
			expect(data).toContain("/rs 原地续接已有会话"); expect(data).toContain("跨进程占用协调");
			expect(data).toContain("可以的，按照这个方式，输出计划"); expect(f.titleRequests[0]!.messages).toHaveLength(2);
			expect(session.messages.slice(0, before.length)).toEqual(before);
			const initial = findActivePlan(f.cwd, f.sessionManager.getSessionId())!.file;
			const entries = structuredClone(f.sessionManager.getBranch());
			vi.mocked(f.ui.select).mockResolvedValueOnce("补充内容");
			await session.prompt("提交计划"); await session.waitForIdle();
			const renamed = findActivePlan(f.cwd, f.sessionManager.getSessionId())!.file;
			expect(renamed.path).not.toBe(initial.path);
			expect(path.basename(renamed.path)).toBe(path.basename(initial.path).replace("缓存计划-", "缓存回归-"));
			expect(renamed.metadata.createdAt).toBe(initial.metadata.createdAt);
			expect(fs.existsSync(initial.path)).toBe(false);
			expect(f.sessionManager.getBranch().slice(0, entries.length)).toEqual(entries);
			const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "plan");
			expect(JSON.stringify(result)).toContain(renamed.path);
			await session.prompt("改名后继续补充"); await session.waitForIdle();
			expect(f.prefixErrors).toEqual([]); expect(f.errors).toEqual([]);
			expect(f.titleRequests).toHaveLength(1);
			expect(fs.readdirSync(path.dirname(renamed.path))).toEqual([path.basename(renamed.path)]);
			expect(JSON.stringify(session.messages)).not.toContain("为任务生成简短文件名标题");
		} finally { session.dispose(); }
	});
	it("标题辅助请求取消及迟到结果均不创建计划或进入主会话历史", async () => {
		const f = await fixture(false, true); const session = await f.open();
		try {
			let cancel: ((value: string | undefined) => void) | undefined;
			vi.mocked(f.ui.select).mockImplementationOnce(() => new Promise((resolve) => { cancel = resolve; }));
			const pending = session.prompt("/plan 取消创建");
			await eventually(() => f.titleRequests.length === 1 && cancel !== undefined);
			cancel!(undefined); await pending; await session.waitForIdle();
			expect(f.titleRequests).toHaveLength(1); expect(f.requests).toHaveLength(0);
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())).toBeUndefined();
			expect(fs.existsSync(path.join(f.cwd, ".pi", "taropi", "plans"))).toBe(false);
			f.finishTitle(); await Promise.resolve(); await Promise.resolve();
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())).toBeUndefined();
			expect(f.notifications.join("\n")).toContain("创建已取消");
			expect(JSON.stringify(session.messages)).not.toContain("为任务生成简短文件名标题");
			await session.prompt("普通任务"); await session.waitForIdle();
			expect(f.requests).toHaveLength(1);
			expect(f.errors).toEqual([]); expect(f.prefixErrors).toEqual([]);
		} finally { session.dispose(); }
	});
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
			const beforeSupplement = f.requests.length;
			await session.prompt("提交计划"); await session.waitForIdle();
			expect(f.requests).toHaveLength(beforeSupplement + 1);
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
			expect(f.titleRequests).toHaveLength(1);
			expect(f.titleRequests[0]).toMatchObject({ model: "planner" });
			expect(f.titleRequests[0]!.messages).toHaveLength(2);
			expect(f.titleRequests[0]!.messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("当前 /plan 参数：\n修复缓存") }] });
			expect(JSON.stringify(f.titleRequests[0]!.messages[1])).toContain("已有对话");
			expect(JSON.stringify(session.messages)).not.toContain("为任务生成简短文件名标题");
			expect(JSON.stringify(session.messages)).not.toContain('"text":"缓存计划"');
			expect(f.sessionManager.getEntries().filter((entry) => entry.type === "custom" || entry.type === "custom_message" || entry.type === "context_edit")).toEqual([]);
			expect(f.prefixErrors).toEqual([]);
			expect(f.errors).toEqual([]);
		} finally { session.dispose(); }
	}, 15000);
	it.each(["补充内容", "暂不决定", undefined])("决策 %s 停止同批后续工具及排队续跑，正文与手动模型保留，再输入才继续", async (choice) => {
		const f = await fixture(); const session = await f.open(undefined, true);
		try {
			await session.prompt("/plan 取消后继续"); await session.waitForIdle();
			await session.setModel(f.runtime.getModel("plan-test", "manual")!);
			fs.writeFileSync(path.join(f.cwd, "context.txt"), "调研上下文");
			let decide: ((value: string | undefined) => void) | undefined;
			vi.mocked(f.ui.select).mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
			const before = f.requests.length;
			const pending = session.prompt("批量提交"); await eventually(() => decide !== undefined);
			await session.steer("排队补充"); await session.followUp("排队后续");
			decide!(choice); await pending; await session.waitForIdle();
			expect(f.requests).toHaveLength(before + 1);
			expect(fs.existsSync(path.join(f.cwd, "unexpected.txt"))).toBe(false);
			expect(fs.existsSync(path.join(f.cwd, "implementation.txt"))).toBe(false);
			expect(f.compactCount()).toBe(0); expect(session.model?.id).toBe("manual");
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())).toMatchObject({ planText: PLAN,
				file: { metadata: { status: "planning", pendingLaunch: false, adjustmentRounds: choice === "补充内容" ? 1 : 0 } } });
			const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "plan");
			expect(result).toMatchObject({ isError: false });
			// 使用 TUI 的队列回填语义，避免草稿在 SDK 低层循环检查中断前被消费。
			expect(f.restoredDrafts).toEqual(["排队补充\n\n排队后续"]);
			expect(session.getSteeringMessages()).toEqual([]); expect(session.getFollowUpMessages()).toEqual([]);
			const text = "新的补充\n保留原文 /tmp/example.png";
			await session.prompt(text); await session.waitForIdle();
			expect(f.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text }] });
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())?.file.metadata.status).toBe("planning");
			await session.prompt("退出 plan"); expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())).toBeUndefined();
			expect(f.errors).toEqual([]); expect(f.prefixErrors).toEqual([]);
		} finally { session.dispose(); }
	}, 15000);
	it("真实会话确认期间中断，即使确认同时返回实施也只保持 planning，重建后不自动请求", async () => {
		const f = await fixture(); let session = await f.open();
		try {
			await session.prompt("/plan 中断确认"); await session.waitForIdle();
			let decide: ((value: string | undefined) => void) | undefined;
			vi.mocked(f.ui.select).mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
			const count = f.requests.length;
			const pending = session.prompt("提交计划"); await eventually(() => decide !== undefined);
			const aborted = session.abort(); decide!("开始实施"); await pending; await aborted;
			expect(f.requests).toHaveLength(count + 1);
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())?.file.metadata).toMatchObject({ status: "planning", pendingLaunch: false, adjustmentRounds: 0 });
			expect(session.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "plan", isError: false });
			session.dispose(); session = await f.open(session.model!);
			expect(f.requests).toHaveLength(count + 1); expect(f.compactCount()).toBe(0);
			await session.prompt("确认中断后继续"); await session.waitForIdle();
			expect(findActivePlan(f.cwd, f.sessionManager.getSessionId())?.file.metadata.status).toBe("planning");
			expect(f.errors).toEqual([]); expect(f.prefixErrors).toEqual([]);
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
