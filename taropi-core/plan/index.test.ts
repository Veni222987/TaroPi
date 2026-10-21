import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, type CompactOptions, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "./config.ts";
import { findActivePlan } from "./file.ts";
import registerPlan from "./index.ts";
import { switchPlanModel } from "./runtime.ts";
import { PlanWorkflow } from "./workflow.ts";

vi.mock("./runtime.ts", () => ({ switchPlanModel: vi.fn(async () => undefined) }));
const directories: string[] = [];
const PLAN = "目标：修复\nPlan:\n计划标题：测试\n1. 修改\n风险：无";
const originalLoad = configModule.loadPlanConfig;
beforeEach(() => { vi.spyOn(configModule, "loadPlanConfig").mockImplementation(() => originalLoad("/nonexistent-plan-config.json")); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(switchPlanModel).mockReset(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function setup() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-workflow-")); directories.push(cwd);
	const api = { sendUserMessage: vi.fn(), setModel: vi.fn(), setActiveTools: vi.fn(), appendEntry: vi.fn(),
		registerTool: vi.fn(), registerCommand: vi.fn(), on: vi.fn(), events: createEventBus() };
	const pi = api as unknown as ExtensionAPI;
	const notify = vi.fn();
	const select = vi.fn(async () => "开始实施" as string | undefined);
	const input = vi.fn(async () => "补充边界" as string | undefined);
	const compact = vi.fn<(options?: CompactOptions) => void>();
	const ctx = { cwd, mode: "rpc", hasUI: true, ui: { notify, select, input },
		sessionManager: { getSessionId: () => "session-a" }, compact, waitForIdle: vi.fn(async () => undefined),
		isIdle: () => true, hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;
	const workflow = new PlanWorkflow(pi, vi.fn());
	workflow.restore(ctx);
	return { workflow, ctx, api, select, input, compact, notify, cwd };
}
async function drain(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
const userInput = (text: string): InputEvent => ({ type: "input", source: "interactive", text });

describe("Plan 注册与三态流转", () => {
	it("工具声明固定，只有 /plan 命令能进入，禁止上下文注入和会话存状态", () => {
		const { api } = setup(); registerPlan(api as unknown as ExtensionAPI);
		expect(api.registerCommand.mock.calls[0]?.[0]).toBe("plan");
		const tool = api.registerTool.mock.calls[0]?.[0];
		expect(tool).toMatchObject({ name: "plan", exposure: "model-only", executionMode: "sequential" });
		expect(tool.parameters.properties.action.enum).toEqual(["status", "submit", "complete", "exit"]);
		expect(api.on.mock.calls.map(([name]) => name)).toEqual(["tool_call", "input", "agent_settled", "session_compact_failed", "session_start", "session_shutdown"]);
		expect(api.appendEntry).not.toHaveBeenCalled(); expect(api.setActiveTools).not.toHaveBeenCalled();
	});
	it("idle 的流转请求失败，入口立刻持久化，重复入口不重发提示", async () => {
		const { workflow, ctx, api, cwd } = setup();
		for (const action of ["submit", "complete", "exit"] as const) await expect(workflow.dispatch({ action, text: PLAN }, ctx)).rejects.toThrow("只有用户执行 /plan");
		await workflow.enter("", ctx); expect(workflow.state.phase).toBe("idle");
		await workflow.enter("任务", ctx); await workflow.enter("重复任务", ctx);
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(findActivePlan(cwd, "session-a")?.file.metadata.status).toBe("planning");
		expect(workflow.blockReason("write")).toContain("仅可读");
		expect(workflow.blockReason("edit")).toBeDefined(); expect(workflow.blockReason("bash")).toBeUndefined();
	});
	it("确认后的同批写工具仍阻止，compact 之后只发一次实施提示", async () => {
		const { workflow, ctx, compact, api, cwd } = setup(); await workflow.enter("任务", ctx);
		await expect(workflow.dispatch({ action: "submit", text: "无编号" }, ctx)).rejects.toThrow("编号");
		expect(await workflow.dispatch({ action: "submit", text: PLAN }, ctx)).toMatchObject({ terminate: true });
		expect(workflow.blockReason("write")).toBeDefined();
		workflow.settled(ctx, false); workflow.settled(ctx, false);
		expect(compact).toHaveBeenCalledTimes(1);
		compact.mock.calls[0]?.[0]?.onComplete?.({ summary: "摘要", firstKeptEntryId: "entry", tokensBefore: 1 }); await drain();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(2);
		const text = api.sendUserMessage.mock.calls[1]![0] as string;
		await workflow.input({ type: "input", source: "extension", text }, ctx);
		expect(workflow.blockReason("write")).toBeUndefined();
		expect(findActivePlan(cwd, "session-a")?.file.metadata.pendingLaunch).toBe(false);
		await expect(workflow.dispatch({ action: "complete" }, ctx)).rejects.toThrow("摘要");
		const result = await workflow.dispatch({ action: "complete", text: "结果、验证、风险" }, ctx);
		expect(result.text).toContain("非 plan"); expect(workflow.state.phase).toBe("idle");
		expect(findActivePlan(cwd, "session-a")).toBeUndefined();
		expect(vi.mocked(switchPlanModel).mock.calls.map((call) => call[2])).toEqual(["Au", "Ag"]);
	});
	it("补充、Esc 和 abort 不结束计划，自然语言工具退出保留历史", async () => {
		const { workflow, ctx, select, cwd } = setup(); await workflow.enter("任务", ctx);
		select.mockResolvedValueOnce("补充内容");
		expect((await workflow.dispatch({ action: "submit", text: PLAN }, ctx)).text).toContain("补充边界");
		expect(workflow.state.adjustmentRounds).toBe(1);
		select.mockResolvedValueOnce(undefined);
		expect(await workflow.dispatch({ action: "submit", text: PLAN }, ctx)).toMatchObject({ terminate: true });
		workflow.settled(ctx, true); expect(workflow.state.phase).toBe("planning");
		expect(await workflow.input(userInput("继续"), ctx)).toBeUndefined();
		const file = workflow.state.planFile!.path;
		await workflow.dispatch({ action: "exit" }, ctx);
		expect(fs.readFileSync(file, "utf8")).toContain('status: "exited"');
		expect(findActivePlan(cwd, "session-a")).toBeUndefined();
	});
	it("恢复 pendingLaunch 不自动续跑，下次输入补发规则并保留图片", async () => {
		const { workflow, ctx, compact, api } = setup(); await workflow.enter("任务", ctx);
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		workflow.invalidate(); workflow.restore(ctx); workflow.settled(ctx, false);
		expect(compact).not.toHaveBeenCalled();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(await workflow.input({ type: "input", source: "extension", text: "其他扩展自动续跑" }, ctx)).toBeUndefined();
		expect(workflow.state.pendingLaunch).toBe(true);
		const event = { ...userInput("继续"), images: [{ type: "image" as const, data: "a", mimeType: "image/png" }] };
		const result = await workflow.input(event, ctx);
		expect(result).toMatchObject({ action: "transform", images: event.images });
		expect(result && "text" in result ? result.text : "").toContain(PLAN);
		expect(await workflow.input(userInput("再继续"), ctx)).toBeUndefined();
	});
	it("压缩失败可以降级启动，用户取消则保持 pendingLaunch", async () => {
		const { workflow, ctx, compact, api } = setup(); await workflow.enter("任务", ctx);
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx); workflow.settled(ctx, false);
		workflow.compactFailed(true); compact.mock.calls[0]?.[0]?.onError?.(new Error("取消")); await drain();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1); expect(workflow.state.pendingLaunch).toBe(true);
		await workflow.input(userInput("继续"), ctx); expect(workflow.state.pendingLaunch).toBe(false);
	});
	it("非取消压缩失败告警后启动；启动前 complete 不能冒充完成", async () => {
		const { workflow, ctx, compact, api, notify } = setup(); await workflow.enter("任务", ctx);
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		await expect(workflow.dispatch({ action: "complete", text: "提前完成" }, ctx)).rejects.toThrow("已启动");
		workflow.settled(ctx, false); compact.mock.calls[0]?.[0]?.onError?.(new Error("provider 不可用")); await drain();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("压缩失败"), "warning");
	});
	it("旧会话的压缩、模型切换及确认回调不能污染新会话", async () => {
		const { workflow, ctx, compact, api, select } = setup(); await workflow.enter("任务", ctx);
		let confirm: ((value: string) => void) | undefined;
		select.mockImplementationOnce(() => new Promise<string>((resolve) => { confirm = resolve; }));
		const pending = workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		workflow.invalidate(); confirm?.("开始实施");
		await expect(pending).rejects.toThrow("会话已切换"); expect(workflow.state.phase).toBe("planning");
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx); workflow.settled(ctx, false);
		workflow.invalidate(); compact.mock.calls[0]?.[0]?.onError?.(new Error("失败")); await drain();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
	});
	it("切模型期间退出后，旧回调不得发送实施消息", async () => {
		const { workflow, ctx, compact, api } = setup(); await workflow.enter("任务", ctx);
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		let switched: (() => void) | undefined;
		vi.mocked(switchPlanModel).mockImplementationOnce(() => new Promise<void>((resolve) => { switched = resolve; }));
		workflow.settled(ctx, false);
		compact.mock.calls[0]?.[0]?.onComplete?.({ summary: "摘要", firstKeptEntryId: "entry", tokensBefore: 1 });
		await workflow.dispatch({ action: "exit" }, ctx); switched?.(); await drain();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(workflow.state.phase).toBe("idle");
	});
	it("每阶段独立工具策略、无 UI、写入失败安全降级", async () => {
		const { workflow, ctx, notify } = setup();
		workflow.config.idle.blockedTools = ["bash"]; expect(workflow.blockReason("bash")).toContain("idle");
		await workflow.enter("任务", ctx);
		await expect(workflow.dispatch({ action: "submit", text: PLAN }, { ...ctx, hasUI: false } as ExtensionContext)).rejects.toThrow("没有确认 UI");
		fs.rmSync(path.dirname(workflow.state.planFile!.path), { recursive: true });
		fs.writeFileSync(path.dirname(workflow.state.planFile!.path), "占位");
		await workflow.dispatch({ action: "exit" }, ctx);
		expect(notify.mock.calls.some(([message]) => String(message).includes("未能持久化"))).toBe(true);
		expect(workflow.state.phase).toBe("idle");
	});
});
