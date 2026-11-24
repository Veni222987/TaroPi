import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerAsk } from "./index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function setup(idle = true): { api: ExtensionAPI; command: Command; notify: ReturnType<typeof vi.fn> } {
	let command: Command | undefined;
	const api = {
		registerCommand: vi.fn((_name: string, registered: Command) => { command = registered; }),
		sendUserMessage: vi.fn(),
		sendMessage: vi.fn(),
		registerTool: vi.fn(),
		setActiveTools: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI;
	registerAsk(api);
	const notify = vi.fn();
	const ctx = { isIdle: () => idle, ui: { notify } } as unknown as ExtensionCommandContext;
	const registered = command!;
	return { api, command: { ...registered, handler: (args) => registered.handler(args, ctx) }, notify };
}

describe("/ask 一次性查证回答", () => {
	it("只注册 ask，不注册工具、钩子或改变工具列表", () => {
		const { api } = setup();
		expect(vi.mocked(api.registerCommand).mock.calls.map(([name]) => name)).toEqual(["ask"]);
		for (const method of [api.sendMessage, api.registerTool, api.setActiveTools, api.on]) {
			expect(method).not.toHaveBeenCalled();
		}
	});

	it("空参数、空白和忙碌时都不发消息", async () => {
		const idle = setup();
		await idle.command.handler("   ", {} as ExtensionCommandContext);
		expect(idle.notify).toHaveBeenCalledWith("用法：/ask 问题", "warning");
		expect(idle.api.sendUserMessage).not.toHaveBeenCalled();

		const busy = setup(false);
		await busy.command.handler("为什么重试", {} as ExtensionCommandContext);
		expect(busy.notify).toHaveBeenCalledWith("当前正在回复，请等待结束后再使用 /ask", "warning");
		expect(busy.api.sendUserMessage).not.toHaveBeenCalled();
	});

	it("空闲时只发一次，保留原样问题并禁止展开模板", async () => {
		const { api, command } = setup();
		const question = '  为什么 /plan "确认"\n会重放  ';
		await command.handler(question, {} as ExtensionCommandContext);
		expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
		const [message, options] = vi.mocked(api.sendUserMessage).mock.calls[0]!;
		expect(message).toContain("1. 结论");
		expect(message).toContain("2. 至少一个可核对的详细例子");
		expect(message).toContain("3. 相关证据");
		expect(message).toContain(`问题：\n${question.trim()}`);
		expect(options).toEqual({ expandPromptTemplates: false });
	});
});
