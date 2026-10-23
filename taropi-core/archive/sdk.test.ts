import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager,
	type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanFile, findActivePlan, publishPlanFile } from "../plan/file.ts";
import registerPlan from "../plan/index.ts";
import registerArchive from "./index.ts";

vi.mock("../model-alias/store.ts", () => ({ resolveModelAlias: () => undefined }));
vi.mock("../plan/config.ts", () => ({ loadPlanConfig: () => ({ idle: { blockedTools: [], prompt: "" }, planning: { blockedTools: [], prompt: "" }, implementing: { blockedTools: [], prompt: "" } }) }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture(shutdownWrites = false) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "archive-runtime-")); directories.push(cwd);
	const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
	const sessionDir = path.join(cwd, "sessions"); fs.mkdirSync(sessionDir);
	const requests: Message[][] = [], titles: Message[][] = [], errors: string[] = [], notices: string[] = [];
	const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	models.registerProvider("archive-test", {
		api: "anthropic-messages", apiKey: "test", baseUrl: "https://invalid.example",
		models: [{ id: "model", name: "model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, context, options) => {
			const title = JSON.stringify(context.messages[0]).includes("为这段会话概括");
			(title ? titles : requests).push(structuredClone(context.messages));
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: title ? "修复归档命令" : "收到" }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			if (!title && JSON.stringify(context.messages.at(-1)).includes("挂起请求")) {
				queueMicrotask(() => stream.push({ type: "start", partial: message }));
				const cancel = (): void => stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
				if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener("abort", cancel, { once: true });
			} else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({ defaultProvider: "archive-test", defaultModel: "model", defaultThinkingLevel: "low", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	const shutdown = (pi: ExtensionAPI): void => {
		if (shutdownWrites) pi.on("session_shutdown", () => pi.appendEntry("old-shutdown", { value: "不应带入新会话" }));
	};
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime: models,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [registerPlan, registerArchive, shutdown] } });
		return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" }), services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionDir) });
	const ui = { notify: (message: string) => notices.push(message), confirm: async () => true,
		select: (_title: string, _items: string[], options?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })),
	} as unknown as ExtensionUIContext;
	const bind = async (): Promise<void> => {
		const session = runtime.session;
		await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: (error) => errors.push(error.error),
			abortHandler: () => { session.clearQueue(); void session.abort(); },
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(), switchSession: (file, options) => runtime.switchSession(file, options),
				newSession: (options) => runtime.newSession(options), fork: (entryId, options) => runtime.fork(entryId, options),
				navigateTree: async () => ({ cancelled: true }), reload: async () => { throw new Error("未用于此测试"); },
			},
		});
	};
	runtime.setRebindSession(bind); await bind();
	return { cwd, runtime, requests, titles, errors, notices, sessionDir };
}

describe("真实 AgentSessionRuntime 归档回归（mock provider）", () => {
	it("归档中止正在生成的回复，排队消息不进入新会话", async () => {
		const f = await fixture();
		try {
			const session = f.runtime.session;
			const pending = session.prompt("挂起请求");
			for (let i = 0; !f.requests.length && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(f.requests).toHaveLength(1);
			await session.followUp("排队不应执行");
			await session.prompt("/archive"); await pending;
			expect(f.runtime.session.messages).toEqual([]);
			expect(f.runtime.session.pendingMessageCount).toBe(0); expect(f.requests).toHaveLength(1);
			const files = await SessionManager.list(f.cwd, f.sessionDir);
			const archived = files.find((item) => item.name?.endsWith("(archived)"))!;
			expect(fs.readFileSync(archived.path, "utf8")).toContain('"stopReason":"aborted"');
			expect(f.errors).toEqual([]);
		} finally { await f.runtime.dispose(); }
	}, 15000);
	it.each([false, true])("原路径继续、独立归档检索恢复、plan 终止，shutdown 写入：%s", async (shutdownWrites) => {
		const f = await fixture(shutdownWrites); const runtime: AgentSessionRuntime = f.runtime;
		try {
			await runtime.session.prompt("旧需求一：修复文件归档"); await runtime.session.prompt("旧需求二：原地继续");
			const manager = runtime.session.sessionManager;
			manager.appendSessionInfo("持续工作");
			const file = manager.getSessionFile()!, id = manager.getSessionId();
			const before = structuredClone(runtime.session.messages);
			expect(f.requests[1]!.slice(0, f.requests[0]!.length)).toEqual(f.requests[0]);
			const plan = createPlanFile(f.cwd, id, "归档前计划", new Date(Date.now() - 1000)); publishPlanFile(plan);
			await runtime.session.prompt("/archive");
			expect(runtime.session.sessionFile).toBe(file); expect(runtime.session.sessionManager.getSessionId()).toBe(id);
			expect(runtime.session.sessionManager.getSessionName()).toBe("持续工作"); expect(runtime.session.messages).toEqual([]);
			expect(findActivePlan(f.cwd, id)).toBeUndefined(); expect(fs.readFileSync(plan.path, "utf8")).toContain('status: "exited"');
			const listed = await SessionManager.list(f.cwd, f.sessionDir);
			expect(listed).toHaveLength(2); expect(new Set(listed.map((item) => item.id)).size).toBe(2);
			const archived = listed.find((item) => item.id !== id)!;
			expect(archived.name).toBe("修复归档命令 (archived)"); expect(path.basename(archived.path)).toMatch(/^修复归档命令-archived-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.jsonl$/);
			expect(SessionManager.open(archived.path).buildSessionContext().messages).toEqual(before);
			expect(f.titles).toHaveLength(1); expect(JSON.stringify(f.titles[0])).toContain("旧需求二");
			expect(fs.readFileSync(file, "utf8")).not.toContain("不应带入新会话");
			await runtime.session.prompt("新需求：从零开始");
			expect(JSON.stringify(f.requests[2])).not.toContain("旧需求");
			expect(fs.readFileSync(file, "utf8")).toContain("新需求：从零开始");
			await runtime.switchSession(archived.path);
			expect(runtime.session.messages).toEqual(before);
			expect(f.errors).toEqual([]);
		} finally { await runtime.dispose(); }
	}, 15000);
});
