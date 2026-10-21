import { CURSOR_MARKER, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { PlanFile } from "./types.ts";

const EXECUTE_PLAN_LABEL = "开始实施";
const ADJUST_PLAN_LABEL = "补充内容";

export interface PlanDecision {
	execute: boolean;
	feedback?: string;
	cancelled?: boolean;
}

function isPrintableInput(data: string): boolean {
	if (data.length === 0) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

// PlanDecisionPage 渲染计划确认与补充内容输入界面。
export class PlanDecisionPage {
	private selected: 0 | 1 = 0;
	private buffer = "";
	focused = true;
	private readonly cancel = (): void => this.onDecide({ execute: false, cancelled: true });

	constructor(
		private readonly theme: Theme,
		private readonly onDecide: (decision: PlanDecision) => void,
		private readonly planPath?: string,
		private readonly signal?: AbortSignal,
	) {
		signal?.addEventListener("abort", this.cancel, { once: true });
	}

	// dispose 清理取消监听，避免已关闭弹窗响应后续中断。
	dispose(): void {
		this.signal?.removeEventListener("abort", this.cancel);
	}

	// handleInput 接受确认、补充或取消键。
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = 0;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = 1;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.onDecide(this.selected === 0 ? { execute: true } : { execute: false, feedback: this.buffer.trim() || undefined });
			return;
		}
		if (this.selected !== 1) return;
		if (matchesKey(data, Key.backspace)) {
			this.buffer = this.buffer.slice(0, -1);
			return;
		}
		if (isPrintableInput(data)) this.buffer += data;
	}

	// render 按终端宽度折行，保持窄屏和中文路径可读。
	render(width: number): string[] {
		const lines = [this.theme.bold("计划已生成，如何继续？")];
		lines.push(this.theme.fg("dim", this.planPath ? `计划文件: ${this.planPath}` : "计划文件未能写入：.pi/taropi/plans"));
		lines.push("");

		for (const [index, label, description] of [
			[0, EXECUTE_PLAN_LABEL, "进入主 Agent 实施阶段"],
			[1, ADJUST_PLAN_LABEL, "移到此行直接输入调整意见，回车提交（可留空）"],
		] as const) {
			const active = index === this.selected;
			const pointer = active ? "❯ " : "  ";
			if (index === 1 && active) {
				const cursor = `${CURSOR_MARKER}\x1b[7m \x1b[27m`;
				lines.push(this.theme.fg("accent", `${pointer}${index + 1}. ${label}：${this.buffer}${cursor}`));
			} else {
				const line = `${pointer}${index + 1}. ${label}`;
				lines.push(active ? this.theme.fg("accent", line) : line);
			}
			lines.push(`    ${this.theme.fg("dim", description)}`);
		}

		lines.push("", this.theme.fg("dim", "Enter 确认 · ↑/↓ 切换 · Esc 取消"));
		return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
	}

	// invalidate 界面每次渲染都从当前主题和输入构造，不缓存布局。
	invalidate(): void {}
}

// showPlanDecision 只负责确认交互，文件写入由工作流负责。
export async function showPlanDecision(ctx: ExtensionContext, planText: string, file?: PlanFile, signal?: AbortSignal): Promise<PlanDecision> {
	if (!ctx.hasUI) throw new Error("当前模式没有确认 UI，不能批准实施；请在 TUI 或 RPC 会话中提交计划");
	if (signal?.aborted) return { execute: false, cancelled: true };
	if (ctx.mode !== "tui") {
		const choice = await ctx.ui.select(`计划文件：${file?.path ?? "未保存"}\n\n${planText}`, [EXECUTE_PLAN_LABEL, ADJUST_PLAN_LABEL], { signal });
		if (!choice || signal?.aborted) return { execute: false, cancelled: true };
		if (choice === EXECUTE_PLAN_LABEL) return { execute: true };
		const feedback = await ctx.ui.input("补充内容", "可以留空，继续澄清", { signal });
		return feedback === undefined ? { execute: false, cancelled: true } : { execute: false, feedback };
	}
	return ctx.ui.custom<PlanDecision>(
		(tui, theme, keybindings, done) => {
			const page = new PlanDecisionPage(theme, done, file?.path, signal);
			return {
				get focused() { return page.focused; },
				set focused(value: boolean) { page.focused = value; },
				render: (width: number) => page.render(width),
				invalidate: () => page.invalidate(),
				dispose: () => page.dispose(),
				handleInput: (data: string) => {
					page.handleInput(keybindings.matches(data, "app.interrupt") ? "\x1b" : data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", margin: { left: 0, right: 0, bottom: 0 } } },
	);
}
