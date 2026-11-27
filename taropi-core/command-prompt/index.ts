import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export interface CommandPromptDetails {
	input?: string;
	status?: string;
}

interface CommandPromptOptions {
	deliverAs?: "steer" | "followUp";
	triggerTurn: boolean;
}

// registerCommandPromptRenderer 为指令注入消息注册渲染器，只显示原始输入或一行状态，永不显示注入的提示词
export function registerCommandPromptRenderer(pi: ExtensionAPI, customType: string): void {
	const renderer: MessageRenderer<CommandPromptDetails> = (message, options, theme) => {
		const input = readStringField(message.details, "input");
		if (input) return new UserMessageComponent(input, getMarkdownTheme(), options.outputPad);
		const status = readStringField(message.details, "status");
		if (status) return new Text(theme.fg("dim", status), options.outputPad, 0);
		return new Container();
	};
	pi.registerMessageRenderer(customType, renderer);
}

// sendCommandPrompt 把提示词作为模型可见的自定义消息发送，界面只渲染 details
export function sendCommandPrompt(pi: ExtensionAPI, customType: string, prompt: string, details: CommandPromptDetails, options: CommandPromptOptions): void {
	pi.sendMessage({ customType, content: prompt, display: true, details }, options);
}

// readCommandInput 从自定义消息 details 中读取原始指令输入，格式不符时返回 undefined
export function readCommandInput(details: unknown): string | undefined {
	return readStringField(details, "input");
}

function readStringField(details: unknown, key: keyof CommandPromptDetails): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const value = (details as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}
