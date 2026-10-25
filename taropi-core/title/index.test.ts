import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTitle, titleInput } from "./index.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("通用短标题", () => {
	it.each(["provider", "empty", "error", "model"])("未配置回退时 %s 失败不拿会话名充当概括", async (failure) => {
		const manager = SessionManager.inMemory();
		manager.appendSessionInfo("原会话名称"); manager.appendMessage({ role: "user", content: "实际活动", timestamp: 1 });
		const before = structuredClone(manager.getBranch());
		const streamSimple = vi.fn(() => ({ result: async () => {
			if (failure === "provider") throw new Error("请求失败");
			return { content: [{ type: "text", text: failure === "empty" ? "" : "活动概括" }], stopReason: failure === "error" ? "error" : "stop" };
		} }));
		const notify = vi.fn();
		const ctx = { hasUI: false, sessionManager: manager, model: failure === "model" ? undefined : { id: "current" }, modelRegistry: { streamSimple }, ui: { notify } } as unknown as ExtensionContext;
		expect(await generateTitle("概括当前活动", ctx, { prompt: "活动概括", dialogTitle: "标题" }, new AbortController().signal)).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("未生成标题"), "warning");
		expect(manager.getBranch()).toEqual(before);
	});
	it.each(["empty", "read"])("严格概括遇到 %s 上下文不发送泛化任务请求", async (failure) => {
		const manager = SessionManager.inMemory(); manager.appendSessionInfo("原会话名称");
		if (failure === "read") vi.spyOn(manager, "getBranch").mockImplementationOnce(() => { throw new Error("读取失败"); });
		const streamSimple = vi.fn(), notify = vi.fn();
		const ctx = { hasUI: false, sessionManager: manager, model: { id: "current" }, modelRegistry: { streamSimple }, ui: { notify } } as unknown as ExtensionContext;
		expect(await generateTitle("概括当前活动", ctx, { prompt: "活动概括", dialogTitle: "标题" }, new AbortController().signal)).toBeUndefined();
		expect(streamSimple).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("未生成标题"), "warning");
	});
	it("严格概括超时停止，不回退原会话名", async () => {
		vi.useFakeTimers();
		const manager = SessionManager.inMemory(); manager.appendMessage({ role: "user", content: "实际活动", timestamp: 1 });
		const notify = vi.fn();
		const ctx = { hasUI: false, sessionManager: manager, model: { id: "current" }, modelRegistry: { streamSimple: () => ({ result: () => new Promise(() => {}) }) }, ui: { notify } } as unknown as ExtensionContext;
		const pending = generateTitle("概括活动", ctx, { prompt: "活动概括", dialogTitle: "标题" }, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await pending).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("超时"), "warning");
	});
	it("参数化指令、任务标签和回退值，不向主会话写入消息", async () => {
		const manager = SessionManager.inMemory(); manager.appendMessage({ role: "user", content: "实际工作", timestamp: 1 });
		const before = structuredClone(manager.getBranch());
		const streamSimple = vi.fn(() => ({ result: async () => ({ content: [{ type: "text", text: "新标题" }], stopReason: "stop" }) }));
		const ctx = { hasUI: false, sessionManager: manager, model: { id: "current" }, modelRegistry: { streamSimple }, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
		const options = { prompt: "归档命名专用", dialogTitle: "归档标题", fallback: "原会话名", taskLabel: "归档目标" };
		expect(await generateTitle("当前任务", ctx, options, new AbortController().signal)).toBe("新标题");
		expect(streamSimple).toHaveBeenCalledWith(ctx.model, expect.objectContaining({ systemPrompt: "归档命名专用", messages: [expect.objectContaining({ content: [{ type: "text", text: titleInput("当前任务", manager.getBranch(), "归档目标") }] })] }), expect.anything());
		streamSimple.mockImplementationOnce(() => { throw new Error("超时"); });
		expect(await generateTitle("不是回退标题", ctx, options, new AbortController().signal)).toBe("原会话名");
		expect(await generateTitle("任务", { ...ctx, model: undefined }, { ...options, fallback: "/:*?", defaultTitle: "session" }, new AbortController().signal)).toBe("session");
		expect(manager.getBranch()).toEqual(before);
	});
});
