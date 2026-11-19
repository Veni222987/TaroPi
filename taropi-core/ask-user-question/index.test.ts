import { initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	buildItemsForQuestion,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	DEFAULT_TOOL_DESCRIPTION,
} from "./ask-user-question.ts";
import { formatKeySpecForDisplay, resolveCollapseKey } from "./config.ts";
import registerAskUserQuestion, { ASK_USER_BLOCKED_EVENT, ASK_USER_PROMPT_EVENT } from "./index.ts";
import { reconcileAskUserQuestionTool } from "./reconcile.ts";
import { runRpcQuestionnaire } from "./rpc-fallback.ts";
import { QuestionnaireSession } from "./state/questionnaire-session.ts";
import { normalizeQuestionParams, parseOptionString } from "./tool/normalize-params.ts";
import { buildQuestionnaireResponse, DECLINE_MESSAGE } from "./tool/response-envelope.ts";
import { QuestionParamsSchema } from "./tool/types.ts";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import { PreviewBlockRenderer } from "./view/components/preview/preview-block-renderer.ts";
import { PreviewPane } from "./view/components/preview/preview-pane.ts";
import { OptionListView } from "./view/components/option-list-view.ts";

function maxObjectDepth(schema: unknown, depth = 0): number {
	if (!schema || typeof schema !== "object") return depth;
	const s = schema as Record<string, unknown>;
	const currentDepth = s.type === "object" ? depth + 1 : depth;
	let max = currentDepth;
	if (s.properties && typeof s.properties === "object") {
		for (const child of Object.values(s.properties as Record<string, unknown>)) {
			max = Math.max(max, maxObjectDepth(child, currentDepth));
		}
	}
	if (s.items) {
		max = Math.max(max, maxObjectDepth(s.items, currentDepth));
	}
	return max;
}

function createFakeTheme(): Theme {
	return {
		fg: (_role: string, text: string) => text,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function createFakeTui(columns = 120, rows = 40): TUI {
	return {
		terminal: { columns, rows },
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function createFakeKeybindings() {
	return {
		matches(data: string, name: string): boolean {
			const map: Record<string, string[]> = {
				"tui.select.up": ["\x1b[A"],
				"tui.select.down": ["\x1b[B"],
				"tui.select.confirm": ["\r"],
				"tui.input.submit": ["\r"],
				"tui.select.cancel": ["\x1b"],
				"tui.input.newLine": ["\x1b\r"],
				"tui.editor.cursorUp": ["\x1b[A"],
				"tui.editor.cursorDown": ["\x1b[B"],
				"tui.editor.deleteToLineStart": ["\x15"],
				"app.editor.external": ["\x07"],
			};
			return (map[name] ?? []).includes(data);
		},
	};
}

describe("ask-user-question Schema 与中文提示词", () => {
	it("工具参数 Schema 对象嵌套深度不超过 2 层，兼容 Gemini 调用", () => {
		expect(maxObjectDepth(QuestionParamsSchema)).toBeLessThanOrEqual(2);
		const questionSchema = QuestionParamsSchema.properties.questions.items;
		expect(questionSchema.properties.options.type).toBe("array");
		expect(questionSchema.properties.options.items.type).toBe("string");
		expect(questionSchema.properties.previews.type).toBe("array");
		expect(questionSchema.properties.previews.items.type).toBe("string");
	});

	it("核心提示词与工具描述使用中文", () => {
		expect(DEFAULT_PROMPT_SNIPPET).toContain("结构化问题");
		expect(DEFAULT_TOOL_DESCRIPTION).toContain("选项名称 — 选项说明");
		expect(DEFAULT_TOOL_DESCRIPTION).toContain("previews");
		expect(DEFAULT_PROMPT_GUIDELINES.join("\n")).toContain("（推荐）");
		expect(DEFAULT_PROMPT_GUIDELINES.join("\n")).toContain("输入内容");
	});
});

describe("选项归一化与校验", () => {
	it("支持多种分隔符解析字符串选项并按索引合并 previews", () => {
		expect(parseOptionString("方案 A（推荐） — 改动最小")).toEqual({
			label: "方案 A（推荐）",
			description: "改动最小",
		});
		expect(parseOptionString("方案 B - 性能最好")).toEqual({
			label: "方案 B",
			description: "性能最好",
		});
		expect(parseOptionString("方案 C：兼容旧接口")).toEqual({
			label: "方案 C",
			description: "兼容旧接口",
		});
		expect(parseOptionString("纯选项名")).toEqual({
			label: "纯选项名",
			description: "",
		});

		const normalized = normalizeQuestionParams({
			questions: [
				{
					question: "选择存储格式\r？",
					header: "格式",
					options: ["JSON — 易读", "SQLite — 适合查询"],
					previews: ["```json\n{\"ok\":true}\n```", ""],
				},
			],
		});

		expect(normalized.questions[0]).toEqual({
			question: "选择存储格式？",
			header: "格式",
			options: [
				{ label: "JSON", description: "易读", preview: "```json\n{\"ok\":true}\n```" },
				{ label: "SQLite", description: "适合查询" },
			],
		});
	});

	it("拦截中英文保留词与重复选项", () => {
		for (const reserved of ["其他", "其它", "输入内容", "下一个", "Other", "Type something.", "Next"]) {
			const params = normalizeQuestionParams({
				questions: [{ question: "怎么选？", header: "选择", options: ["方案 A — 说明", `${reserved} — 说明`] }],
			});
			const res = validateQuestionnaire(params);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe("reserved_label");
		}

		const dup = normalizeQuestionParams({
			questions: [{ question: "怎么选？", header: "选择", options: ["方案 A — 说明1", "方案 A — 说明2"] }],
		});
		const dupRes = validateQuestionnaire(dup);
		expect(dupRes.ok).toBe(false);
		if (!dupRes.ok) expect(dupRes.error).toBe("duplicate_option_label");
	});
});

describe("中文回答信封与配置", () => {
	it("生成中文回答信封（含预览、备注与全局备注）", () => {
		const params = normalizeQuestionParams({
			questions: [{ question: "采用哪种方案？", header: "方案", options: ["方案 A — 简单", "方案 B — 灵活"] }],
		});

		const answered = buildQuestionnaireResponse(
			{
				answers: [
					{
						questionIndex: 0,
						question: "采用哪种方案？",
						kind: "option",
						answer: "方案 A",
						preview: "```ts\nconst a = 1;\n```",
						notes: "保持最小改动",
					},
				],
				cancelled: false,
				globalNote: "今晚完成",
			},
			params,
		);
		expect(answered.content[0].text).toContain("用户已回答你的问题：");
		expect(answered.content[0].text).toContain("「采用哪种方案？」=「方案 A」");
		expect(answered.content[0].text).toContain("所选预览：");
		expect(answered.content[0].text).toContain("用户备注：保持最小改动");
		expect(answered.content[0].text).toContain("全局备注：今晚完成");

		const declined = buildQuestionnaireResponse({ answers: [], cancelled: true }, params);
		expect(declined.content[0].text).toBe(DECLINE_MESSAGE);
	});

	it("collapseKey 校验与展示格式正确", () => {
		expect(resolveCollapseKey({})).toBe("ctrl+]");
		expect(resolveCollapseKey({ collapseKey: "off" })).toBe("off");
		expect(resolveCollapseKey({ collapseKey: "alt+o" })).toBe("alt+o");
		expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe("ctrl+]");
		expect(formatKeySpecForDisplay("ctrl+]")).toBe("Ctrl+]");
		expect(formatKeySpecForDisplay("ctrl+pagedown")).toBe("Ctrl+PageDown");
	});
});

describe("TUI 会话与 Preview 预览渲染", () => {
	it("PreviewPane 在宽屏下并排渲染 Markdown 预览，且中文文案生效", () => {
		const theme = createFakeTheme();
		const params = normalizeQuestionParams({
			questions: [
				{
					question: "选择架构方案？",
					header: "架构",
					options: ["模块化 — 结构清晰", "单文件 — 零拆分"],
					previews: ["```ts\nexport const mode = 'modular';\n```", ""],
				},
			],
		});
		const q = params.questions[0];
		const items = buildItemsForQuestion(q);
		expect(items[2]).toEqual({ kind: "other", label: "输入内容" });

		const optionListView = new OptionListView({
			items,
			theme: {
				selectedText: (s) => s,
				description: (s) => s,
				scrollInfo: (s) => s,
			},
		});
		const previewBlock = new PreviewBlockRenderer({
			question: q,
			theme,
			markdownTheme: {
				heading: (s) => s,
				link: (s) => s,
				linkUrl: (s) => s,
				code: (s) => s,
				codeBlock: (s) => s,
				codeBlockBorder: (s) => s,
				quote: (s) => s,
				quoteBorder: (s) => s,
				hr: (s) => s,
				listBullet: (s) => s,
				bold: (s) => s,
				italic: (s) => s,
				strikethrough: (s) => s,
				underline: (s) => s,
			},
		});
		const pane = new PreviewPane({
			question: q,
			getTerminalWidth: () => 120,
			optionListView,
			previewBlock,
		});
		pane.setGlobalLeftWidth(() => 40);
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });

		const sideBySide = pane.render(120).join("\n");
		expect(sideBySide).toContain("模块化");
		expect(sideBySide).toContain("export const mode = 'modular';");
		expect(sideBySide).toContain("备注：按 n 添加");

		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: true, inputMode: false });
		const noPreview = pane.render(120).join("\n");
		expect(noPreview).toContain("暂无预览");
	});

	it("QuestionnaireSession 支持选择并带回所选预览", () => {
		initTheme();
		const params = normalizeQuestionParams({
			questions: [
				{
					question: "选择构建工具？",
					header: "构建",
					options: ["Vite — 启动快", "Webpack — 生态全"],
					previews: ["```ts\nexport default defineConfig({});\n```", ""],
				},
			],
		});
		const done = vi.fn();
		const session = new QuestionnaireSession({
			tui: createFakeTui(),
			theme: createFakeTheme(),
			params,
			itemsByTab: params.questions.map(buildItemsForQuestion),
			done,
			keybindings: createFakeKeybindings(),
			editInput: async () => undefined,
			collapseKey: "ctrl+]",
			canReopenWhileHidden: false,
		});

		const initialRender = session.component.render(120).join("\n");
		expect(initialRender).toContain("回车选择");
		expect(initialRender).toContain("输入内容");
		expect(initialRender).toContain("defineConfig");

		session.component.handleInput("\r");
		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "选择构建工具？",
					kind: "option",
					answer: "Vite",
					preview: "```ts\nexport default defineConfig({});\n```",
				},
			],
			cancelled: false,
		});
	});

	it("切换不同高度的预览选项时，补齐高度放在底部分隔线上方，底部提示栏下方无空白行", () => {
		initTheme();
		const tallPreview = Array.from({ length: 14 }, (_, i) => `- 行 ${i + 1}`).join("\n");
		const params = normalizeQuestionParams({
			questions: [
				{
					question: "选择预览测试？",
					header: "预览",
					options: ["高预览 — 14 行内容", "短预览 — 2 行内容"],
					previews: [tallPreview, "- 短内容"],
				},
				{
					question: "第二题？",
					header: "确认",
					options: ["是 — 继续", "否 — 停止"],
				},
			],
		});
		const session = new QuestionnaireSession({
			tui: createFakeTui(120, 40),
			theme: createFakeTheme(),
			params,
			itemsByTab: params.questions.map(buildItemsForQuestion),
			done: vi.fn(),
			keybindings: createFakeKeybindings(),
			editInput: async () => undefined,
			collapseKey: "ctrl+]",
			canReopenWhileHidden: false,
		});

		const linesOpt1 = session.component.render(120);
		expect(linesOpt1[linesOpt1.length - 1]).toContain("回车选择");

		// 切到较短的第二个选项：总高度保持稳定，且最后一行仍然是底部提示栏，无下方空行
		session.component.handleInput("\x1b[B");
		const linesOpt2 = session.component.render(120);
		expect(linesOpt2.length).toBe(linesOpt1.length);
		expect(linesOpt2[linesOpt2.length - 1]).toContain("回车选择");
	});
});

describe("RPC 降级与工具注册", () => {
	it("RPC 模式使用中文选项与预览标题并支持单选/多选/自定义回答", async () => {
		const params = normalizeQuestionParams({
			questions: [
				{
					question: "主方案选哪个？",
					header: "方案",
					options: ["方案 A — 推荐", "方案 B — 备选"],
					previews: ["preview-A", ""],
				},
				{
					question: "需要哪些能力？",
					header: "能力",
					options: ["日志 — 输出调试日志", "缓存 — 减少重复请求"],
					multiSelect: true,
				},
			],
		});

		const select = vi.fn().mockResolvedValueOnce("1. 方案 A — 推荐");
		const input = vi.fn().mockResolvedValueOnce("1，2");
		const res = await runRpcQuestionnaire({ select, input }, params);

		expect(select.mock.calls[0][0]).toContain("预览");
		expect(select.mock.calls[0][1]).toContain("3. 输入内容");
		expect(res).toEqual({
			cancelled: false,
			answers: [
				{
					questionIndex: 0,
					question: "主方案选哪个？",
					kind: "option",
					answer: "方案 A",
					preview: "preview-A",
				},
				{
					questionIndex: 1,
					question: "需要哪些能力？",
					kind: "multi",
					answer: null,
					selected: ["日志", "缓存"],
				},
			],
		});
	});

	it("注册工具、事件与非交互态 reconciler", async () => {
		const registeredTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
		let activeTools = [ASK_USER_QUESTION_TOOL_NAME, "read"];
		const emit = vi.fn();
		const pi = {
			registerTool: vi.fn((tool) => registeredTools.push(tool)),
			on: vi.fn(),
			getActiveTools: vi.fn(() => activeTools),
			setActiveTools: vi.fn((next: string[]) => {
				activeTools = next;
			}),
			events: { emit },
		} as unknown as ExtensionAPI;

		registerAskUserQuestion(pi);
		expect(registeredTools).toHaveLength(1);
		expect(registeredTools[0].name).toBe(ASK_USER_QUESTION_TOOL_NAME);

		// reconciler 在无 UI 时移除工具，有 UI 时恢复
		reconcileAskUserQuestionTool(pi, { hasUI: false } as ExtensionContext);
		expect(activeTools).toEqual(["read"]);
		reconcileAskUserQuestionTool(pi, { hasUI: true } as ExtensionContext);
		expect(activeTools).toEqual(["read", ASK_USER_QUESTION_TOOL_NAME]);

		// RPC 端到端 execute
		const rpcCtx = {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: vi.fn().mockResolvedValue("1. 选项一 — 说明"),
				input: vi.fn(),
			},
		};
		const result = (await registeredTools[0].execute(
			"call-1",
			{
				questions: [{ question: "确认执行？", header: "确认", options: ["选项一 — 说明", "选项二 — 说明"] }],
			},
			undefined,
			undefined,
			rpcCtx,
		)) as { content: Array<{ text: string }> };

		expect(result.content[0].text).toContain("用户已回答你的问题：");
		expect(result.content[0].text).toContain("「确认执行？」=「选项一」");
		expect(emit).toHaveBeenCalledWith(ASK_USER_PROMPT_EVENT, expect.any(Object));
		expect(emit).toHaveBeenCalledWith(ASK_USER_BLOCKED_EVENT, { active: true });
		expect(emit).toHaveBeenCalledWith(ASK_USER_BLOCKED_EVENT, { active: false });
	});
});
