import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerPlan from "./index.ts";
import { planStatePath } from "./store.ts";

const tempDirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("计划工作流真实 AgentSession 回归", () => {
	it("带签名 thinking 的连续请求只追加，规划和实施不变更模型及工具", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-plan-sdk-"));
		tempDirs.push(cwd);
		const agentDir = path.join(cwd, "agent");
		const requests: Message[][] = [];
		let previousTranscript: Message[] = [];
		const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("plan-test", {
			api: "anthropic-messages", apiKey: "test-key", baseUrl: "https://invalid.example",
			models: [{ id: "planner", name: "测试模型", reasoning: true, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
			streamSimple: (model, context) => {
				const transcript = structuredClone(context.messages);
				// 模拟提供商对已签名 thinking 的前缀绑定检查，改写历史会立即失败。
				if (previousTranscript.length > 0) {
					expect(transcript.slice(0, previousTranscript.length - 1)).toEqual(previousTranscript.slice(0, -1));
					expect(transcript[previousTranscript.length - 1]).toMatchObject(previousTranscript.at(-1)!);
				}
				requests.push(transcript);
				const step = requests.length;
				const writeAttempt = step === 2 || step === 6;
				const text = step === 3 ? "需求已明确，请继续补充边界。" : step === 4 || step === 5 ? "Plan:\n计划标题：前缀回归\n1. 执行修复" : "完成";
				const response: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "thinking", thinking: "测试思考", thinkingSignature: `bound-signature-${step}` },
						...(writeAttempt ? [{ type: "toolCall" as const, id: `write-${step}`, name: "write",
							arguments: { path: "implementation.txt", content: "用户确认后写入" } }] : [{ type: "text" as const, text }])],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: writeAttempt ? "toolUse" : "stop", timestamp: Date.now(),
				};
				previousTranscript = [...transcript, structuredClone(response)];
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: writeAttempt ? "toolUse" : "stop", message: response });
				});
				return stream;
			},
		});
		const model = runtime.getModel("plan-test", "planner");
		if (!model) throw new Error("测试模型注册失败");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [registerPlan],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, settingsManager, sessionManager,
			resourceLoader, tools: ["read", "bash", "edit", "write"], thinkingLevel: "medium" });
		const notifications: string[] = [];
		const errors: string[] = [];
		let reviewCount = 0;
		const ui = {
			notify: (message: string) => { notifications.push(message); },
			select: async () => ++reviewCount === 1 ? "补充内容" : "开始实施",
			input: async () => "补充失败降级",
		} as unknown as ExtensionUIContext;
		try {
			await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: (error) => { errors.push(error.error); } });
			const tools = session.getActiveToolNames();
			await session.prompt("已有对话");
			await session.prompt("/plan 修复签名问题");
			await session.waitForIdle();
			expect(fs.existsSync(path.join(cwd, "implementation.txt"))).toBe(false);
			await session.prompt("边界明确，生成计划");
			await session.waitForIdle();
			await session.prompt("计划结束后继续对话");
			await session.waitForIdle();
			expect(errors).toEqual([]);
			expect(requests).toHaveLength(8);
			for (const request of requests) expect(request.filter((message) => message.role === "system")).toHaveLength(1);
			const blockedWrite = requests[2]?.find((message) => message.role === "toolResult" && message.toolCallId === "write-2");
			expect(blockedWrite).toMatchObject({ isError: true });
			expect(fs.readFileSync(path.join(cwd, "implementation.txt"), "utf-8")).toBe("用户确认后写入");
			expect(session.model).toEqual(model);
			expect(session.getActiveToolNames()).toEqual(tools);
			expect(sessionManager.getEntries().filter((entry) => entry.type === "custom" || entry.type === "custom_message" || entry.type === "compaction")).toEqual([]);
			expect(fs.existsSync(planStatePath(cwd, sessionManager.getSessionId()))).toBe(false);
			expect(notifications.join("\n")).toContain("计划实施轮次已结束");
		} finally {
			session.dispose();
		}
	}, 15000);
});
