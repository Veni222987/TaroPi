import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerAsk } from "./index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function setup(idle = true): { api: ExtensionAPI; command: Command; notify: ReturnType<typeof vi.fn> } {
	let command: Command | undefined;
	const api = {
		registerCommand: vi.fn((_name: string, registered: Command) => { command = registered; }),
		registerMessageRenderer: vi.fn(),
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
	it("只注册 ask 与消息渲染器，不注册工具、钩子或改变工具列表", () => {
		const { api } = setup();
		expect(vi.mocked(api.registerCommand).mock.calls.map(([name]) => name)).toEqual(["ask"]);
		expect(vi.mocked(api.registerMessageRenderer).mock.calls.map(([name]) => name)).toEqual(["taropi-ask"]);
		for (const method of [api.sendMessage, api.sendUserMessage, api.registerTool, api.setActiveTools, api.on]) {
			expect(method).not.toHaveBeenCalled();
		}
	});

	it("空参数、空白和忙碌时都不发消息", async () => {
		const idle = setup();
		await idle.command.handler("   ", {} as ExtensionCommandContext);
		expect(idle.notify).toHaveBeenCalledWith("用法：/ask 问题", "warning");
		expect(idle.api.sendMessage).not.toHaveBeenCalled();

		const busy = setup(false);
		await busy.command.handler("为什么重试", {} as ExtensionCommandContext);
		expect(busy.notify).toHaveBeenCalledWith("当前正在回复，请等待结束后再使用 /ask", "warning");
		expect(busy.api.sendMessage).not.toHaveBeenCalled();
	});

	it("空闲时只发一条可显示消息，原始输入外显而提示词进入正文", async () => {
		const { api, command } = setup();
		const question = '  为什么 /plan "确认"\n会重放  ';
		await command.handler(question, {} as ExtensionCommandContext);
		expect(api.sendUserMessage).not.toHaveBeenCalled();
		expect(api.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = vi.mocked(api.sendMessage).mock.calls[0]!;
		expect(message).toMatchObject({ customType: "taropi-ask", display: true });
		expect((message.details as { input?: string }).input).toBe(`/ask ${question.trim()}`);
		const content = message.content as string;
		expect(content).toContain("1. 总览：");
		expect(content).toContain("2. 分步拆解（按步骤或模块循环展开，每一步都成套给出）：");
		expect(content).toContain("步骤说明：");
		expect(content).toContain("详细例子：");
		expect(content).toContain("相关证据：");
		expect(content).toContain(`问题：\n${question.trim()}`);
		expect(options).toEqual({ triggerTurn: true });
	});
});
