import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, type CompactOptions, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "./config.ts";
import * as fileModule from "./file.ts";
import { findActivePlan } from "./file.ts";
import registerPlan from "./index.ts";
import { switchPlanModel } from "./runtime.ts";
import { generatePlanTitle } from "./title.ts";
import { PlanWorkflow } from "./workflow.ts";

vi.mock("./title.ts", () => ({ generatePlanTitle: vi.fn() }));
vi.mock("./runtime.ts", () => ({ switchPlanModel: vi.fn(async () => undefined) }));
const directories: string[] = [];
const PLAN = "目标：修复\nPlan:\n计划标题：测试\n1. 修改\n风险：无";
const originalLoad = configModule.loadPlanConfig;
beforeEach(() => {
	vi.spyOn(configModule, "loadPlanConfig").mockImplementation(() => originalLoad("/nonexistent-plan-config.json"));
	vi.mocked(generatePlanTitle).mockImplementation(async (task) => task);
});
afterEach(() => {
	vi.restoreAllMocks(); vi.useRealTimers();
	vi.mocked(switchPlanModel).mockReset(); vi.mocked(generatePlanTitle).mockReset();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-workflow-")); directories.push(cwd);
	const api = { sendUserMessage: vi.fn(), setModel: vi.fn(), setActiveTools: vi.fn(), appendEntry: vi.fn(),
		registerTool: vi.fn(), registerCommand: vi.fn(), on: vi.fn(), events: createEventBus() };
	const pi = api as unknown as ExtensionAPI;
	const notify = vi.fn();
	const select = vi.fn<ExtensionContext["ui"]["select"]>(async () => "开始实施");
	const input = vi.fn(async () => "补充边界" as string | undefined);
	const compact = vi.fn<(options?: CompactOptions) => void>();
	const ctx = { cwd, mode: "rpc", hasUI: true, ui: { notify, select, input }, abort: vi.fn(),
		sessionManager: { getSessionId: () => "session-a", getHeader: () => null }, compact, waitForIdle: vi.fn(async () => undefined),
		isIdle: () => true, hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;
	const workflow = new PlanWorkflow(pi, vi.fn());
	workflow.restore(ctx);
	return { workflow, ctx, api, select, input, compact, notify, cwd };
}
async function drain(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
const userInput = (text: string): InputEvent => ({ type: "input", source: "interactive", text });

describe("Plan 注册与三态流转", () => {
	it.each([false, true])("会话重建后活动 plan 终止，待启动：%s", async (pending) => {
		const f = setup(); await f.workflow.enter("重建前计划", f.ctx);
		if (pending) await f.workflow.dispatch({ action: "submit", text: PLAN }, f.ctx);
		const file = f.workflow.state.planFile!;
		const header = { type: "session", id: "session-a", timestamp: new Date(Date.parse(file.metadata.createdAt) + 1000).toISOString() };
		const ctx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getHeader: () => header } } as ExtensionCommandContext;
		f.workflow.restore(ctx);
		expect(f.workflow.state.phase).toBe("idle"); expect(findActivePlan(f.cwd, "session-a")).toBeUndefined();
		expect(fs.readFileSync(file.path, "utf8")).toContain('status: "exited"');
		expect(fs.readFileSync(file.path, "utf8")).toContain("pendingLaunch: false");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("活动 plan 已终止"), "info");
		f.workflow.restore(ctx); expect(f.workflow.state.phase).toBe("idle");
	});
	it("退出状态保存失败仍保持 idle，损坏时间不终止正常计划", async () => {
		const f = setup(); await f.workflow.enter("保留计划", f.ctx);
		const file = f.workflow.state.planFile!;
		const ctx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getHeader: () => ({ timestamp: "invalid" }) } } as ExtensionCommandContext;
		f.workflow.restore(ctx); expect(f.workflow.state.phase).toBe("planning");
		ctx.sessionManager.getHeader = () => ({ timestamp: new Date(Date.parse(file.metadata.createdAt) + 1000).toISOString() }) as ReturnType<ExtensionContext["sessionManager"]["getHeader"]>;
		vi.spyOn(fileModule, "savePlanFile").mockReturnValueOnce(false);
		f.workflow.restore(ctx); expect(f.workflow.state.phase).toBe("idle");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("保存失败"), "warning");
	});
	it("工具声明固定，只有 /plan 命令能进入，禁止上下文注入和会话存状态", () => {
		const { api } = setup(); registerPlan(api as unknown as ExtensionAPI);
		expect(api.registerCommand.mock.calls[0]?.[0]).toBe("plan");
		const tool = api.registerTool.mock.calls[0]?.[0];
		expect(tool).toMatchObject({ name: "plan", exposure: "model-only", executionMode: "sequential" });
		expect(tool.parameters.properties.action.enum).toEqual(["status", "submit", "complete", "exit"]);
		expect(api.on.mock.calls.map(([name]) => name)).toEqual(["tool_call", "input", "agent_settled", "session_compact_failed", "session_start", "session_shutdown"]);
		expect(api.appendEntry).not.toHaveBeenCalled(); expect(api.setActiveTools).not.toHaveBeenCalled();
	});
	it("标题等待期间重复入口不发起第二次请求，submit 改名后实施和退出路径固定", async () => {
		const { workflow, ctx, api } = setup();
		let finish: ((title: string) => void) | undefined;
		vi.mocked(generatePlanTitle).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		const pending = workflow.enter("原始任务\n所有细节", ctx); await drain();
		expect(workflow.state.phase).toBe("idle");
		await workflow.enter("第二个任务", ctx); expect(api.sendUserMessage).not.toHaveBeenCalled();
		finish!("短标题"); await pending;
		const file = workflow.state.planFile!;
		expect(path.basename(file.path)).toMatch(/^短标题-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
		expect(file.metadata.task).toBe("原始任务\n所有细节");
		const originalPath = file.path;
		const result = await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		const renamed = workflow.state.planFile!.path;
		expect(renamed).not.toBe(originalPath); expect(path.basename(renamed)).toMatch(/^测试-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
		expect(result.text).toContain(renamed); expect(fs.existsSync(originalPath)).toBe(false);
		await workflow.dispatch({ action: "exit" }, ctx);
		expect(fs.existsSync(renamed)).toBe(true);
	});
	it("每次 submit 同步标题和原创建分钟，确认框与工具结果都给出新路径，恢复不改名", async () => {
		vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 22, 22, 55));
		const { workflow, ctx, select, cwd } = setup(); await workflow.enter("输出计划", ctx);
		const initial = workflow.state.planFile!.path;
		vi.setSystemTime(new Date(2026, 9, 23, 0, 12));
		select.mockResolvedValueOnce("补充内容");
		const first = await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		const pathA = workflow.state.planFile!.path;
		expect(path.basename(pathA)).toBe("测试-2026-10-22-22-55.md"); expect(first.text).toContain(pathA);
		expect(select.mock.calls.at(-1)?.[0]).toContain(pathA);
		const revised = PLAN.replace("计划标题：测试", "计划标题：更好的标题");
		select.mockResolvedValueOnce("暂不决定");
		const second = await workflow.dispatch({ action: "submit", text: revised }, ctx);
		const pathB = workflow.state.planFile!.path;
		expect(path.basename(pathB)).toBe("更好的标题-2026-10-22-22-55.md"); expect(second.text).toContain(pathB);
		expect(fs.existsSync(initial)).toBe(false); expect(fs.existsSync(pathA)).toBe(false);
		workflow.restore(ctx); expect(workflow.state.planFile!.path).toBe(pathB);
		expect(findActivePlan(cwd, "session-a")?.planText).toBe(revised);
		select.mockResolvedValueOnce("暂不决定"); await workflow.dispatch({ action: "submit", text: revised }, ctx);
		expect(workflow.state.planFile!.path).toBe(pathB);
		expect(fs.readdirSync(path.dirname(pathB))).toEqual([path.basename(pathB)]);
	});
	it.each(["exists", "failed"] as const)("submit 改名 %s 仍可确认，告警并保留旧路径", async (result) => {
		const { workflow, ctx, notify, select } = setup(); await workflow.enter("任务", ctx);
		const original = workflow.state.planFile!.path;
		vi.spyOn(fileModule, "renamePlanFile").mockReturnValueOnce(result);
		const response = await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		expect(workflow.state.phase).toBe("implementing"); expect(workflow.state.planFile!.path).toBe(original);
		expect(response.text).toContain(original); expect(select.mock.calls.at(-1)?.[0]).toContain(original);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(result === "exists" ? "已存在" : "改名失败"), "warning");
	});
	it("正文保存失败时不改名，保留原路径和旧磁盘正文", async () => {
		const { workflow, ctx, select } = setup(); await workflow.enter("任务", ctx);
		const original = workflow.state.planFile!.path; const before = fs.readFileSync(original, "utf8");
		vi.spyOn(fileModule, "savePlanFile").mockReturnValueOnce(false);
		const rename = vi.spyOn(fileModule, "renamePlanFile"); select.mockResolvedValueOnce("暂不决定");
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		expect(rename).not.toHaveBeenCalled(); expect(workflow.state.planFile!.path).toBe(original);
		expect(fs.readFileSync(original, "utf8")).toBe(before);
	});
	it("等待 idle 期间也锁住入口，用户新输入可取消创建", async () => {
		const { workflow, ctx, api } = setup();
		let ready: (() => void) | undefined;
		vi.mocked(ctx.waitForIdle).mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
		const pending = workflow.enter("任务", ctx);
		await workflow.enter("任务二", ctx);
		await workflow.input(userInput("先处理别的事情"), ctx);
		ready!(); await pending; expect(workflow.state.phase).toBe("idle");
		expect(api.sendUserMessage).not.toHaveBeenCalled();
	});
	it("会话切换使标题请求失效，旧结果不得创建文件或解锁新请求", async () => {
		const { workflow, ctx, api, cwd } = setup();
		let finish: ((title: string) => void) | undefined;
		vi.mocked(generatePlanTitle).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		const pending = workflow.enter("旧任务", ctx); await drain();
		const next = { ...ctx, sessionManager: { getSessionId: () => "session-b" } } as ExtensionCommandContext;
		workflow.restore(next);
		let finishNext: ((title: string) => void) | undefined;
		vi.mocked(generatePlanTitle).mockImplementationOnce(() => new Promise((resolve) => { finishNext = resolve; }));
		const nextPending = workflow.enter("新任务", next); await drain();
		finish!("过期标题"); await pending;
		await workflow.enter("额外任务", next);
		expect(generatePlanTitle).toHaveBeenCalledTimes(2);
		finishNext!("新标题"); await nextPending;
		expect(findActivePlan(cwd, "session-a")).toBeUndefined();
		expect(workflow.state.planFile?.metadata.sessionId).toBe("session-b");
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fs.readdirSync(path.dirname(workflow.state.planFile!.path))).toHaveLength(1);
	});
	it.each(["exists", "failed"] as const)("首次发布 %s 时保持 idle，不切模型或发送规划消息", async (result) => {
		const { workflow, ctx, api, notify } = setup();
		vi.spyOn(fileModule, "publishPlanFile").mockReturnValueOnce(result);
		await workflow.enter("任务", ctx);
		expect(workflow.state.phase).toBe("idle"); expect(workflow.state.planFile).toBeUndefined();
		expect(api.sendUserMessage).not.toHaveBeenCalled(); expect(switchPlanModel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(result === "exists" ? "同一分钟" : "创建失败"), "warning");
	});
	it("标题取消保持 idle，已完成或退出的同分钟文件也拒绝覆盖", async () => {
		vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 21, 23, 30));
		const { workflow, ctx, api, notify } = setup();
		vi.mocked(generatePlanTitle).mockResolvedValueOnce(undefined);
		await workflow.enter("任务", ctx); expect(workflow.state.phase).toBe("idle");
		expect(api.sendUserMessage).not.toHaveBeenCalled();
		await workflow.enter("任务", ctx);
		const file = workflow.state.planFile!.path;
		await workflow.dispatch({ action: "exit" }, ctx);
		const before = fs.readFileSync(file, "utf8");
		await workflow.enter("任务", ctx);
		expect(workflow.state.phase).toBe("idle"); expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("同一分钟"), "warning");
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
		expect(await workflow.dispatch({ action: "submit", text: PLAN }, ctx)).toMatchObject({ text: expect.stringContaining("主输入框"), terminate: true });
		expect(ctx.ui.input).not.toHaveBeenCalled(); expect(ctx.abort).toHaveBeenCalledTimes(1);
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
	it.each([undefined, "暂不决定"])("取消 %s 是正常结果，保留正文与策略，恢复后等待原样输入", async (choice) => {
		const { workflow, ctx, select, compact, api, cwd } = setup(); await workflow.enter("任务", ctx);
		select.mockResolvedValueOnce(choice);
		expect(await workflow.dispatch({ action: "submit", text: PLAN }, ctx)).toMatchObject({ terminate: true, text: expect.stringContaining("仍在计划中") });
		expect(workflow.state).toMatchObject({ phase: "planning", pendingLaunch: false, adjustmentRounds: 0, planText: PLAN });
		expect(findActivePlan(cwd, "session-a")).toMatchObject({ planText: PLAN, file: { metadata: { status: "planning", adjustmentRounds: 0 } } });
		expect(workflow.blockReason("write")).toBeDefined(); expect(ctx.abort).toHaveBeenCalledTimes(1);
		workflow.settled(ctx, true); workflow.restore(ctx); workflow.settled(ctx, false);
		expect(await workflow.input({ ...userInput("新的补充"), images: [{ type: "image", data: "a", mimeType: "image/png" }] }, ctx)).toBeUndefined();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1); expect(compact).not.toHaveBeenCalled();
		expect(vi.mocked(switchPlanModel).mock.calls.map((call) => call[2])).toEqual(["Au"]);
	});
	it("已取消操作和确认中断不抛异常，即使 UI 同时返回实施也不启动", async () => {
		const { workflow, ctx, select, compact } = setup(); await workflow.enter("任务", ctx);
		const controller = new AbortController(); controller.abort();
		expect(await workflow.dispatch({ action: "submit", text: PLAN }, ctx, controller.signal)).toMatchObject({ terminate: true });
		expect(select).not.toHaveBeenCalled(); expect(workflow.state.planText).toBe("");
		for (const choice of ["开始实施", "补充内容", undefined]) {
			const current = new AbortController();
			select.mockImplementationOnce(async () => { current.abort(); return choice; });
			expect(await workflow.dispatch({ action: "submit", text: PLAN }, ctx, current.signal)).toMatchObject({ terminate: true, text: expect.stringContaining("确认已取消") });
		}
		workflow.settled(ctx, true);
		expect(workflow.state).toMatchObject({ phase: "planning", pendingLaunch: false, adjustmentRounds: 0 });
		expect(compact).not.toHaveBeenCalled();
	});
	it("真正的 UI 错误独立报告，检查点仍可继续", async () => {
		const { workflow, ctx, select, cwd } = setup(); await workflow.enter("任务", ctx);
		select.mockRejectedValueOnce(new Error("UI 连接失效"));
		await expect(workflow.dispatch({ action: "submit", text: PLAN }, ctx)).rejects.toThrow("UI 连接失效");
		expect(ctx.abort).not.toHaveBeenCalled();
		expect(findActivePlan(cwd, "session-a")).toMatchObject({ planText: PLAN, file: { metadata: { status: "planning" } } });
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
		expect(await pending).toMatchObject({ text: expect.stringContaining("确认已失效"), terminate: true });
		expect(ctx.abort).not.toHaveBeenCalled(); expect(workflow.state.phase).toBe("planning");
		await workflow.dispatch({ action: "submit", text: PLAN }, ctx); workflow.settled(ctx, false);
		workflow.invalidate(); compact.mock.calls[0]?.[0]?.onError?.(new Error("失败")); await drain();
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
	});
	it("切到新会话后，旧确认结果不报失败、不修改或中断新计划", async () => {
		const { workflow, ctx, select } = setup(); await workflow.enter("旧任务", ctx);
		let decide: ((value: string | undefined) => void) | undefined;
		select.mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
		const pending = workflow.dispatch({ action: "submit", text: PLAN }, ctx);
		const next = { ...ctx, sessionManager: { getSessionId: () => "session-b" }, abort: vi.fn() } as unknown as ExtensionCommandContext;
		workflow.restore(next); await workflow.enter("新任务", next);
		const state = structuredClone(workflow.state);
		decide!("开始实施");
		expect(await pending).toMatchObject({ text: expect.stringContaining("确认已失效"), terminate: true });
		expect(workflow.state).toEqual(state);
		expect(ctx.abort).not.toHaveBeenCalled(); expect(next.abort).not.toHaveBeenCalled();
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
