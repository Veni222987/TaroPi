import type { AssistantMessage, Context, Model, Api, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelAlias } from "../model-alias/store.ts";
import { generatePlanTitle } from "./title.ts";

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
	const ctx = { model: current, modelRegistry: { streamSimple, find }, hasUI: false, ui: { notify, select } } as unknown as ExtensionContext;
	const controller = new AbortController();
	return { ctx, controller, streamSimple, result, response, current, configured, find, notify, select };
}

describe("计划短标题辅助请求", () => {
	it("解析规划模型别名，仅发送任务和命名指令，不携带历史或工具", async () => {
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
