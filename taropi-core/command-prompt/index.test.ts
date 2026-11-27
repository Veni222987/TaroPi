import { initTheme, UserMessageComponent, type ExtensionAPI, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommandPromptRenderer, readCommandInput, sendCommandPrompt } from "./index.ts";

const themeKeys = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
let savedThemes: unknown[] = [];
beforeEach(() => {
	savedThemes = themeKeys.map((key) => Reflect.get(globalThis, key));
	initTheme("dark", false);
});
afterEach(() => {
	for (const [index, key] of themeKeys.entries()) {
		if (savedThemes[index] === undefined) Reflect.deleteProperty(globalThis, key);
		else Reflect.set(globalThis, key, savedThemes[index]);
	}
});

function rendererFixture(): MessageRenderer<{ input?: string; status?: string }> {
	let renderer: MessageRenderer<{ input?: string; status?: string }> | undefined;
	const api = { registerMessageRenderer: vi.fn((_type, registered) => { renderer = registered; }) } as unknown as ExtensionAPI;
	registerCommandPromptRenderer(api, "taropi-test");
	return renderer!;
}

function message(details: unknown, content = "隐藏的提示词正文") {
	return { role: "custom" as const, customType: "taropi-test", content, display: true, details, timestamp: 1 } as Parameters<MessageRenderer<{ input?: string; status?: string }>>[0];
}

function renderedText(component: { render(width: number): string[] }, width = 160): string {
	return component.render(width).join("\n");
}

function renderOptions(expanded = false): Parameters<MessageRenderer>[1] {
	return { expanded, outputPad: 1, keyText: () => "", keyHint: () => "" };
}

describe("指令注入消息渲染器", () => {
	it("有 input 时渲染成用户消息样式，只显示原始输入", () => {
		const renderer = rendererFixture();
		const component = renderer(message({ input: "/ask 为什么这样" }), renderOptions(), {} as never)!;
		expect(component).toBeInstanceOf(UserMessageComponent);
		const text = renderedText(component);
		expect(text).toContain("/ask 为什么这样");
		expect(text).not.toContain("隐藏的提示词正文");
	});

	it("有 status 时只渲染一行状态", () => {
		const renderer = rendererFixture();
		const component = renderer(message({ status: "🧭 plan 已进入实施阶段" }), renderOptions(), {
			fg: (_token: string, text: string) => text,
		} as never)!;
		expect(component).toBeInstanceOf(Text);
		const text = renderedText(component);
		expect(text).toContain("🧭 plan 已进入实施阶段");
		expect(text).not.toContain("隐藏的提示词正文");
	});

	it("details 缺失或非法时渲染空组件，回退不会外显正文", () => {
		const renderer = rendererFixture();
		for (const details of [undefined, {}, { input: 123 }, { input: "   " }, "非法"]) {
			const component = renderer(message(details), renderOptions(), {} as never)!;
			expect(component).toBeInstanceOf(Container);
			expect((component as Container).children).toHaveLength(0);
			expect(renderedText(component)).toBe("");
		}
	});

	it("expanded 为真时仍不显示注入正文", () => {
		const renderer = rendererFixture();
		const component = renderer(message({ input: "/plan 任务" }), renderOptions(true), {} as never)!;
		expect(renderedText(component)).toContain("/plan 任务");
		expect(renderedText(component)).not.toContain("隐藏的提示词正文");
	});
});

describe("指令注入消息发送与读取", () => {
	it("发送 display 为 true 的自定义消息，正文与 details 分离", () => {
		const sendMessage = vi.fn();
		const api = { sendMessage } as unknown as ExtensionAPI;
		sendCommandPrompt(api, "taropi-test", "提示词", { input: "/ask 问题" }, { triggerTurn: true });
		expect(sendMessage).toHaveBeenCalledWith({
			customType: "taropi-test", content: "提示词", display: true, details: { input: "/ask 问题" },
		}, { triggerTurn: true });
	});

	it("readCommandInput 覆盖正常、空值和非法类型", () => {
		expect(readCommandInput({ input: "/ask 问题" })).toBe("/ask 问题");
		expect(readCommandInput({ input: "  /ask  " })).toBe("  /ask  ");
		expect(readCommandInput({ input: "   " })).toBeUndefined();
		expect(readCommandInput({ input: 42 })).toBeUndefined();
		expect(readCommandInput(undefined)).toBeUndefined();
		expect(readCommandInput(null)).toBeUndefined();
	});
});
