import type { AssistantMessage, Context, Model, Api, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelAlias } from "../model-alias/store.ts";
import { generatePlanTitle, planTitleInput } from "./title.ts";

vi.mock("../model-alias/store.ts", () => ({ resolveModelAlias: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

function fixture() {
	const current = { provider: "test", id: "current" } as Model<Api>;
	const configured = { provider: "test", id: "planner" } as Model<Api>;
	const response = { content: [{ type: "text", text: "# 精简计划文件" }], stopReason: "stop" } as AssistantMessage;
	const result = vi.fn(async () => response);
	const streamSimple = vi.fn((_model: Model<Api>, _context: Context, _options?: ModelsSimpleStreamOptions) => ({ result }));
	const notify = vi.fn();
	const select = vi.fn<ExtensionContext["ui"]["select"]>();
	const find = vi.fn(() => configured as Model<Api> | undefined);
	const sessionManager = SessionManager.inMemory();
	const ctx = { model: current, modelRegistry: { streamSimple, find }, sessionManager, hasUI: false, ui: { notify, select } } as unknown as ExtensionContext;
	const controller = new AbortController();
	return { ctx, controller, streamSimple, result, response, current, configured, find, notify, select, sessionManager };
}

describe("计划短标题辅助请求", () => {
	it("解析规划模型别名，无历史时仅发送任务和命名指令，不携带工具", async () => {
		const f = fixture(); vi.mocked(resolveModelAlias).mockReturnValueOnce("test/planner");
		expect(await generatePlanTitle("原始完整任务\n细节", f.ctx, "Au", f.controller.signal)).toBe("精简计划文件");
		expect(f.find).toHaveBeenCalledWith("test", "planner");
		const [model, context, options] = f.streamSimple.mock.calls[0]!;
		expect(model).toBe(f.configured); expect(f.ctx.model).toBe(f.current);
		expect(context.messages).toEqual([{ role: "user", content: [{ type: "text", text: "原始完整任务\n细节" }], timestamp: expect.any(Number) }]);
		expect(context.systemPrompt).toContain("最多 20"); expect(context.tools).toBeUndefined();
		expect(options).toMatchObject({ maxTokens: 128, cacheRetention: "none", signal: expect.any(AbortSignal) });
		expect(f.notify).not.toHaveBeenCalled();
	});
	it("聊到一半切 /plan 时传递可见上下文，忽略工具、图片与思考且不修改历史", async () => {
		const f = fixture();
		f.sessionManager.appendMessage({ role: "user", content: [
			{ type: "text", text: "企业微信 /fs 改为 /rs 原地续接" }, { type: "image", data: "图片不发送", mimeType: "image/png" },
		], timestamp: 1 });
		f.sessionManager.appendMessage({ ...f.response, role: "assistant", timestamp: 2, content: [
			{ type: "thinking", thinking: "思考不发送" }, { type: "text", text: "需要跨进程占用协调" },
			{ type: "toolCall", id: "call", name: "bash", arguments: { command: "工具参数不发送" } },
		] });
		f.sessionManager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "工具结果不发送" }], isError: false, timestamp: 3 });
		const before = structuredClone(f.sessionManager.getBranch());
		await generatePlanTitle("可以的，按照这个方式，输出计划", f.ctx, undefined, f.controller.signal);
		const context = f.streamSimple.mock.calls[0]![1];
		const data = JSON.stringify(context.messages);
		expect(data).toContain("企业微信 /fs 改为 /rs 原地续接"); expect(data).toContain("跨进程占用协调");
		expect(data).toContain("可以的，按照这个方式，输出计划");
		for (const excluded of ["图片不发送", "思考不发送", "工具参数不发送", "工具结果不发送"]) expect(data).not.toContain(excluded);
		expect(context.systemPrompt).toContain("指代性话语"); expect(context.tools).toBeUndefined();
		expect(context.messages).toHaveLength(1); expect(f.sessionManager.getBranch()).toEqual(before);
	});
	it("只保留最新压缩摘要及其后的会话，不重发压缩前的原始历史", () => {
		const f = fixture();
		f.sessionManager.appendMessage({ role: "user", content: "被压缩的旧任务", timestamp: 1 });
		f.sessionManager.appendCompaction("旧压缩摘要", null, 100);
		f.sessionManager.appendMessage({ role: "user", content: "也被压缩的任务", timestamp: 2 });
		f.sessionManager.appendCompaction("正在处理 /rs 和跨进程锁", null, 200);
		f.sessionManager.appendMessage({ role: "user", content: "不等待，直接接管", timestamp: 3 });
		const data = planTitleInput("输出计划", f.sessionManager.getBranch());
		expect(data).toContain("压缩摘要：\n正在处理 /rs 和跨进程锁"); expect(data).toContain("不等待，直接接管");
		expect(data).not.toContain("被压缩"); expect(data).not.toContain("旧压缩摘要");
	});
	it("当前分支摘要参与命名，但不读取已放弃分支", () => {
		const f = fixture();
		const root = f.sessionManager.appendMessage({ role: "user", content: "共同任务", timestamp: 1 });
		f.sessionManager.appendMessage({ role: "user", content: "已放弃分支的原始文本", timestamp: 2 });
		f.sessionManager.branchWithSummary(root, "分支结论：原地续接");
		expect(planTitleInput("输出计划", f.sessionManager.getBranch())).toContain("分支结论：原地续接");
		expect(planTitleInput("输出计划", f.sessionManager.getBranch())).not.toContain("已放弃分支的原始文本");
	});
	it.each([false, true])("会话文本最多 8000 个 Unicode 字符，摘要是否存在：%s", (withSummary) => {
		const f = fixture();
		if (withSummary) f.sessionManager.appendCompaction("摘".repeat(10_000), null, 100);
		f.sessionManager.appendMessage({ role: "user", content: "过时文本", timestamp: 1 });
		f.sessionManager.appendMessage({ ...f.response, role: "assistant", timestamp: 2, content: [{ type: "text", text: "鹅🪿".repeat(10_000) }] });
		const data = planTitleInput("新的任务参数必须完整保留", f.sessionManager.getBranch());
		const context = data.split("最近会话（仅供命名参考）：\n")[1]!.split("\n\n当前 /plan 参数：\n")[0]!;
		expect(Array.from(context).length).toBeLessThanOrEqual(8_000);
		expect(context).not.toContain("过时文本"); expect(context).not.toContain("\uFFFD");
		expect(data.endsWith("新的任务参数必须完整保留")).toBe(true);
		if (withSummary) expect(context.startsWith("压缩摘要：\n摘")).toBe(true);
	});
	it("读取上下文失败时仍只用任务概括，不取消创建", async () => {
		const f = fixture(); vi.spyOn(f.sessionManager, "getBranch").mockImplementationOnce(() => { throw new Error("读取失败"); });
		expect(await generatePlanTitle("任务", f.ctx, undefined, f.controller.signal)).toBe("精简计划文件");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("上下文读取失败"), "warning");
		expect(JSON.stringify(f.streamSimple.mock.calls[0]![1].messages)).toContain('"text":"任务"');
	});
	it.each([undefined, "不存在", "test/missing"])("模型 %s 无法解析时沿用当前模型", async (name) => {
		const f = fixture(); f.find.mockReturnValueOnce(undefined);
		await generatePlanTitle("任务", f.ctx, name, f.controller.signal);
		expect(f.streamSimple.mock.calls[0]![0]).toBe(f.current);
	});
	it("模型解析异常也沿用当前模型", async () => {
		const f = fixture(); vi.mocked(resolveModelAlias).mockImplementationOnce(() => { throw new Error("配置损坏"); });
		await generatePlanTitle("任务", f.ctx, "Au", f.controller.signal);
		expect(f.streamSimple.mock.calls[0]![0]).toBe(f.current);
	});
	it.each([
		["# plan", "plan"], ["1. `短标题`", "短标题"], [`**${"鹅".repeat(100)}**`, "鹅".repeat(20)],
	])("成功输出 %s 清理标记及截断，不误判通用标题", async (text, expected) => {
		const f = fixture(); f.response.content = [{ type: "text", text }];
		expect(await generatePlanTitle("任务", f.ctx, undefined, f.controller.signal)).toBe(expected);
		expect(f.notify).not.toHaveBeenCalled();
	});
	it.each(["", "   ", "/:*?<>|", "\n"])("输出 %s 为空或非法时回退首个非空行", async (text) => {
		const f = fixture(); f.response.content = [{ type: "text", text }];
		expect(await generatePlanTitle("\n1. 回退标题\n更多内容", f.ctx, undefined, f.controller.signal)).toBe("回退标题");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("失败"), "warning");
	});
	it.each(["error", "aborted"] as const)("服务返回 %s 且非用户取消时回退", async (reason) => {
		const f = fixture(); f.response.stopReason = reason; f.response.errorMessage = "无凭证";
		expect(await generatePlanTitle("非法/:*?<>|", f.ctx, undefined, f.controller.signal)).toBe("非法");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("无凭证"), "warning");
	});
	it("无模型和请求异常回退，清理后为空使用 plan", async () => {
		const f = fixture();
		expect(await generatePlanTitle("/:*?<>|", { ...f.ctx, model: undefined }, undefined, f.controller.signal)).toBe("plan");
		f.result.mockRejectedValueOnce(new Error("连接失败"));
		expect(await generatePlanTitle("任务", f.ctx, undefined, f.controller.signal)).toBe("任务");
	});
	it("15 秒超时也能回退忽略取消信号的 provider", async () => {
		vi.useFakeTimers(); const f = fixture(); f.result.mockReturnValueOnce(new Promise(() => undefined));
		const pending = generatePlanTitle("超时任务", f.ctx, undefined, f.controller.signal);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await pending).toBe("超时任务"); expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("超时"), "warning");
		expect(f.streamSimple.mock.calls[0]![2]!.signal!.aborted).toBe(true);
	});
	it("取消和会话失效不回退、不继续创建，也不等待 provider 返回", async () => {
		const f = fixture(); f.result.mockReturnValueOnce(new Promise(() => undefined));
		const pending = generatePlanTitle("任务", f.ctx, undefined, f.controller.signal); f.controller.abort();
		expect(await pending).toBeUndefined(); expect(f.notify).not.toHaveBeenCalled();
		f.streamSimple.mockClear();
		expect(await generatePlanTitle("任务", f.ctx, undefined, f.controller.signal)).toBeUndefined();
		expect(f.streamSimple).not.toHaveBeenCalled();
	});
	it("原生选择框取消不回退，正常完成则关闭等待框", async () => {
		const f = fixture(); f.result.mockReturnValueOnce(new Promise(() => undefined)); f.select.mockResolvedValueOnce(undefined);
		expect(await generatePlanTitle("任务", { ...f.ctx, hasUI: true }, undefined, f.controller.signal)).toBeUndefined();
		expect(f.notify).not.toHaveBeenCalled();
		let dialogSignal: AbortSignal | undefined;
		f.select.mockImplementationOnce((_title, _choices, options) => new Promise((resolve) => {
			dialogSignal = options?.signal;
			dialogSignal?.addEventListener("abort", () => resolve(undefined), { once: true });
		}));
		expect(await generatePlanTitle("任务", { ...f.ctx, hasUI: true }, undefined, new AbortController().signal)).toBe("精简计划文件");
		expect(dialogSignal?.aborted).toBe(true);
	});
});
