import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTitle, titleInput } from "./index.ts";

afterEach(() => vi.restoreAllMocks());
describe("通用短标题", () => {
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
