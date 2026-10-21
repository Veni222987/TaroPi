import { CombinedAutocompleteProvider, getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { CustomEditor, getSelectListTheme, initTheme, InteractiveMode, type KeybindingsManager as AppKeybindingsManager, type ExtensionContext, type ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showPlanDecision } from "./tui.ts";
import type { PlanFile } from "./types.ts";

const editorKeys = {
	...TUI_KEYBINDINGS,
	"app.interrupt": { defaultKeys: "ctrl+c", description: "中断" },
	"app.editor.external": { defaultKeys: "ctrl+g", description: "外部编辑器" },
	"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "粘贴图片" },
} as const;
type DialogOptions = Parameters<ExtensionContext["ui"]["select"]>[2];
const themeKeys = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
let savedThemes: unknown[] = [];
let savedKeybindings = getKeybindings();
beforeEach(() => {
	savedThemes = themeKeys.map((key) => Reflect.get(globalThis, key));
	savedKeybindings = getKeybindings();
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager(editorKeys));
});
afterEach(() => {
	vi.restoreAllMocks();
	setKeybindings(savedKeybindings);
	for (const [index, key] of themeKeys.entries()) {
		if (savedThemes[index] === undefined) Reflect.deleteProperty(globalThis, key);
		else Reflect.set(globalThis, key, savedThemes[index]);
	}
});

interface NativeSelectorMethods {
	showExtensionSelector(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
	hideExtensionSelector(): void;
	restoreQueuedMessagesToEditor(options?: { abort?: boolean }): number;
}
const native = InteractiveMode.prototype as unknown as NativeSelectorMethods;

function nativeFixture() {
	let focused: Component | undefined;
	const ui = { terminal: { columns: 80, rows: 24 }, setFocus: (component: Component) => { focused = component; }, requestRender: vi.fn() };
	const editor = new CustomEditor(ui as unknown as TUI, { borderColor: (text) => text, selectList: getSelectListTheme() },
		new KeybindingsManager(editorKeys) as unknown as AppKeybindingsManager);
	editor.setText("未发送草稿");
	const mode = {
		editor, extensionSelector: undefined as ExtensionSelectorComponent | undefined, ui,
		programStatus: { setBlocked: vi.fn() }, editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		disposeActiveSelector: vi.fn(), toggleToolOutputExpansion: vi.fn(),
		hideExtensionSelector: () => native.hideExtensionSelector.call(mode),
	};
	const select = vi.fn((title: string, options: string[], opts?: DialogOptions) => native.showExtensionSelector.call(mode, title, options, opts));
	const ctx = { hasUI: true, mode: "tui", ui: { select } } as unknown as ExtensionContext;
	return { ctx, mode, editor, focus: () => focused };
}

function apiFixture(mode: "tui" | "rpc") {
	const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValue("开始实施");
	const input = vi.fn(), custom = vi.fn(), setEditorText = vi.fn(), setEditorComponent = vi.fn(), pasteToEditor = vi.fn();
	const ctx = { hasUI: true, mode, ui: { select, input, custom, setEditorText, setEditorComponent, pasteToEditor } } as unknown as ExtensionContext;
	return { ctx, select, input, custom, setEditorText, setEditorComponent, pasteToEditor };
}

describe("计划原生确认 UI", () => {
	it.each(["tui", "rpc"] as const)("%s 统一三选项，补充只返回决策，不创建输入框或覆盖草稿", async (mode) => {
		const f = apiFixture(mode);
		const file = { path: ".pi/taropi/plans/中文计划.md" } as PlanFile;
		expect(await showPlanDecision(f.ctx, file)).toBe("execute");
		f.select.mockResolvedValueOnce("补充内容"); expect(await showPlanDecision(f.ctx, file)).toBe("supplement");
		for (const choice of ["暂不决定", undefined, "非法响应"]) {
			f.select.mockResolvedValueOnce(choice); expect(await showPlanDecision(f.ctx, file)).toBe("cancelled");
		}
		expect(f.select).toHaveBeenCalledWith(expect.stringContaining(file.path), ["开始实施", "补充内容", "暂不决定"], { signal: undefined });
		for (const method of [f.input, f.custom, f.setEditorText, f.setEditorComponent, f.pasteToEditor]) expect(method).not.toHaveBeenCalled();
	});
	it("没有 UI 拒绝批准；已中断不弹框；未保存的路径不冒充成功", async () => {
		const f = apiFixture("rpc");
		await expect(showPlanDecision({ ...f.ctx, hasUI: false })).rejects.toThrow("没有确认 UI");
		const controller = new AbortController(); controller.abort();
		expect(await showPlanDecision(f.ctx, undefined, controller.signal)).toBe("cancelled");
		expect(f.select).not.toHaveBeenCalled();
		await showPlanDecision(f.ctx);
		expect(f.select.mock.calls[0]?.[0]).toContain("计划文件: 未保存");
	});
	it("确认时中断优先于实施；只吞已中断的 AbortError，真正的 UI 错误保持可见", async () => {
		const f = apiFixture("rpc"); const controller = new AbortController();
		f.select.mockImplementationOnce(async () => { controller.abort(); return "开始实施"; });
		expect(await showPlanDecision(f.ctx, undefined, controller.signal)).toBe("cancelled");
		f.select.mockRejectedValueOnce(new Error("连接断开"));
		await expect(showPlanDecision(f.ctx)).rejects.toThrow("连接断开");
		const aborted = new AbortController();
		f.select.mockImplementationOnce(async () => { aborted.abort(); throw new DOMException("取消", "AbortError"); });
		expect(await showPlanDecision(f.ctx, undefined, aborted.signal)).toBe("cancelled");
	});
	it.each(["\x1b", "\x03"])("真实原生选择框取消键 %j 恢复同一个主编辑器和草稿", async (key) => {
		const f = nativeFixture(); const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const pending = showPlanDecision(f.ctx, undefined, controller.signal);
		expect(f.focus()).toBe(f.mode.extensionSelector);
		f.mode.extensionSelector!.handleInput(key);
		expect(await pending).toBe("cancelled");
		expect(f.focus()).toBe(f.editor); expect(f.editor.getText()).toBe("未发送草稿");
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		controller.abort(); expect(f.focus()).toBe(f.editor);
	});
	it("真实原生选择框遵循配置快捷键；补充后保留主框编辑、图片和外部编辑器接线", async () => {
		setKeybindings(new KeybindingsManager(editorKeys, { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+y" }));
		const f = nativeFixture();
		const pasteImage = vi.fn(), externalEditor = vi.fn();
		f.editor.onPasteImage = pasteImage;
		f.editor.onAction("app.editor.external", externalEditor);
		const pending = showPlanDecision(f.ctx);
		f.mode.extensionSelector!.handleInput("\x0e"); f.mode.extensionSelector!.handleInput("\x19");
		expect(await pending).toBe("supplement"); expect(f.focus()).toBe(f.editor);
		f.editor.setText("");
		f.editor.handleInput("\x1b[200~多行粘贴\n图片说明\x1b[201~");
		expect(f.editor.getText()).toBe("多行粘贴\n图片说明");
		f.editor.handleInput("\x01"); f.editor.handleInput("前缀");
		expect(f.editor.getText()).toContain("前缀图片说明");
		f.editor.handleInput("\x1f"); expect(f.editor.getText()).toBe("多行粘贴\n图片说明");
		f.editor.handleInput("\x16"); f.editor.handleInput("\x07");
		expect(pasteImage).toHaveBeenCalledTimes(1); expect(externalEditor).toHaveBeenCalledTimes(1);
		f.editor.setText(""); f.editor.addToHistory("已有历史"); f.editor.handleInput("\x1b[A");
		expect(f.editor.getText()).toBe("已有历史");
	});
	it("原生选择框在窄屏折行中文路径", async () => {
		const f = nativeFixture();
		const pending = showPlanDecision(f.ctx, { path: `.pi/taropi/plans/${"中文路径".repeat(20)}.md` } as PlanFile);
		for (const width of [10, 40, 80]) for (const line of f.mode.extensionSelector!.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		f.mode.extensionSelector!.handleInput("\x1b"); expect(await pending).toBe("cancelled");
	});
	it("补充后继续使用主框原有补全提供器", async () => {
		const f = nativeFixture();
		f.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "help", description: "测试命令" }], "/nonexistent-autocomplete-fixture"));
		const pending = showPlanDecision(f.ctx);
		f.mode.extensionSelector!.handleInput("\x1b[B"); f.mode.extensionSelector!.handleInput("\r");
		expect(await pending).toBe("supplement");
		f.editor.setText("/hel"); f.editor.handleInput("\t");
		for (let attempt = 0; attempt < 40 && !f.editor.isShowingAutocomplete(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(f.editor.isShowingAutocomplete()).toBe(true); f.editor.handleInput("\t");
		expect(f.editor.getText()).toBe("/help ");
	});
	it("真实 TUI 中断路径回填排队内容并保留主框草稿，不自动发请求", () => {
		const f = nativeFixture();
		const abort = vi.fn(async () => undefined);
		const mode = { ...f.mode, clearAllQueues: () => ({ steering: ["排队补充"], followUp: ["排队后续"] }),
			updatePendingMessagesDisplay: vi.fn(), session: { abort } };
		expect(native.restoreQueuedMessagesToEditor.call(mode, { abort: true })).toBe(2);
		expect(f.editor.getText()).toBe("排队补充\n\n排队后续\n\n未发送草稿");
		expect(abort).toHaveBeenCalledTimes(1);
	});
	it("真实原生选择框响应 AbortSignal，恢复焦点且不丢失草稿", async () => {
		const f = nativeFixture(); const controller = new AbortController();
		const pending = showPlanDecision(f.ctx, undefined, controller.signal);
		controller.abort(); expect(await pending).toBe("cancelled");
		expect(f.mode.extensionSelector).toBeUndefined(); expect(f.focus()).toBe(f.editor);
		expect(f.editor.getText()).toBe("未发送草稿");
	});
});
