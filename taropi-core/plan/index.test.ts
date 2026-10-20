import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerPlan, { planningFailureReason } from "./index.ts";
import { loadPlanState, planStatePath } from "./store.ts";
import { showPlanDecision } from "./tui.ts";

vi.mock("./tui.ts", () => ({ showPlanDecision: vi.fn() }));

type Handler = (...args: unknown[]) => unknown;
let cwd: string;
beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-plan-index-"));
	vi.mocked(showPlanDecision).mockReset();
});
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

function response(stopReason: AssistantMessage["stopReason"], errorMessage?: string, text = ""): AssistantMessage {
	return { role: "assistant", stopReason, errorMessage, content: [{ type: "text", text }] } as AssistantMessage;
}

function setup() {
	const handlers = new Map<string, Handler>();
	const messages: string[] = [];
	const notifications: string[] = [];
	let command: Handler = () => undefined;
	const api = {
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		registerCommand: (_name: string, definition: { handler: Handler }) => { command = definition.handler; },
		events: { on: vi.fn(), emit: vi.fn() },
		setModel: vi.fn(), setActiveTools: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(),
		sendUserMessage: (message: string) => { messages.push(message); },
	};
	registerPlan(api as unknown as ExtensionAPI);
	const ctx = {
		cwd, hasUI: true, sessionManager: { getSessionId: () => "session-1" },
		waitForIdle: vi.fn().mockResolvedValue(undefined), compact: vi.fn(),
		ui: { notify: (message: string) => { notifications.push(message); } },
	};
	const fire = async (event: string, payload: unknown = {}) => { await handlers.get(event)?.(payload, ctx); };
	return { api, handlers, messages, notifications, ctx, fire, command: (args: string) => command(args, ctx) };
}

describe("计划请求失败恢复", () => {
	it("返回模型错误详情", () => {
		expect(planningFailureReason(response("error", "模块加载失败"))).toBe("模块加载失败");
	});
	it("为取消和无详情错误提供默认原因", () => {
		expect(planningFailureReason(response("aborted"))).toBe("请求已取消");
		expect(planningFailureReason(response("error"))).toBe("模型请求失败");
	});
	it("正常响应不触发失败恢复", () => {
		expect(planningFailureReason(response("stop"))).toBeUndefined();
		expect(planningFailureReason(undefined)).toBeUndefined();
	});
});

describe("计划流程不破坏请求前缀", () => {
	it("整个流程不改模型、工具、历史，不压缩，不将状态写入会话", async () => {
		const env = setup();
		for (const event of ["context", "context_with_system", "before_provider_request", "before_agent_start", "turn_end", "model_select"]) {
			expect(env.handlers.has(event)).toBe(false);
		}
		await env.fire("session_start");
		await env.command("修复签名");
		expect(env.messages[0]).toContain("工作方式");
		expect(await env.handlers.get("tool_call")?.({ toolName: "write" })).toMatchObject({ block: true });
		expect(await env.handlers.get("tool_call")?.({ toolName: "read" })).toBeUndefined();
		vi.mocked(showPlanDecision).mockResolvedValueOnce({ decision: { execute: false, feedback: "补充边界" } });
		await env.fire("agent_end", { messages: [response("stop", undefined, "Plan:\n1. 修复")] });
		expect(env.messages[1]).toContain("补充边界");
		vi.mocked(showPlanDecision).mockResolvedValueOnce({ decision: { execute: true } });
		await env.fire("agent_end", { messages: [response("stop", undefined, "Plan:\n1. 修复")] });
		expect(env.messages[2]).toContain("只读限制已解除");
		expect(await env.handlers.get("tool_call")?.({ toolName: "write" })).toBeUndefined();
		await env.fire("agent_end", { messages: [response("stop")] });
		await env.fire("agent_settled");
		expect(fs.existsSync(planStatePath(cwd, "session-1"))).toBe(false);
		for (const method of [env.api.setModel, env.api.setActiveTools, env.api.appendEntry, env.api.sendMessage, env.ctx.compact]) {
			expect(method).not.toHaveBeenCalled();
		}
	});

	it("等待重试最终结束后清理失败状态并允许重启", async () => {
		const env = setup();
		await env.command("规划");
		await env.fire("agent_end", { messages: [response("error", "Invalid signature")] });
		expect(loadPlanState(planStatePath(cwd, "session-1")).phase).toBe("planning");
		expect(env.notifications).toEqual([]);
		await env.fire("agent_start");
		await env.fire("agent_end", { messages: [response("error", "Invalid signature")] });
		await env.fire("agent_settled");
		expect(env.notifications.join("\n")).toContain("计划制定失败");
		await env.command("再规划");
		expect(env.messages).toHaveLength(2);
	});

	it("Esc 取消不会自动进入下一轮规划", async () => {
		const env = setup();
		await env.command("规划");
		vi.mocked(showPlanDecision).mockResolvedValue({ decision: { execute: false, cancelled: true } });
		await env.fire("agent_end", { messages: [response("stop", undefined, "Plan:\n1. 修复")] });
		expect(env.messages).toHaveLength(1);
		expect(fs.existsSync(planStatePath(cwd, "session-1"))).toBe(false);
	});

	it("实施请求失败不把计划文件标记完成", async () => {
		const env = setup();
		await env.command("规划");
		const file = { path: path.join(cwd, "plan.md"), createdAt: new Date() };
		vi.mocked(showPlanDecision).mockResolvedValue({ decision: { execute: true }, file });
		await env.fire("agent_end", { messages: [response("stop", undefined, "Plan:\n1. 修复")] });
		await env.fire("agent_end", { messages: [response("aborted")] });
		await env.fire("agent_settled");
		expect(fs.readFileSync(file.path, "utf-8")).not.toContain("✓ 已完成");
		expect(env.notifications.join("\n")).toContain("计划实施中断");
	});

	it("无界面和空任务不启动工作流，关闭会话清理状态", async () => {
		const env = setup();
		await env.command("");
		env.ctx.hasUI = false;
		await env.command("规划");
		expect(env.messages).toEqual([]);
		env.ctx.hasUI = true;
		await env.command("规划");
		await env.fire("session_shutdown");
		expect(fs.existsSync(planStatePath(cwd, "session-1"))).toBe(false);
	});
});
