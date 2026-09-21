import { CURSOR_MARKER, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { savePlanFile, type PlanFile } from "./file.ts";

const EXECUTE_PLAN_LABEL = "开始实施";
const ADJUST_PLAN_LABEL = "补充内容";

export interface PlanDecision {
	execute: boolean;
	feedback?: string;
}

export interface PlanReview {
	decision: PlanDecision;
	file?: PlanFile;
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

	constructor(
		private readonly theme: Theme,
		private readonly onDecide: (decision: PlanDecision) => void,
		private readonly planPath?: string,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onDecide({ execute: false });
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

	render(_width: number): string[] {
		const lines = [this.theme.bold("计划已生成，如何继续？")];
		lines.push(this.theme.fg("dim", this.planPath ? `计划文件已保存至: ${this.planPath}` : "计划文件未能写入：.pi/taropi/plans"));
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
		return lines;
	}

	invalidate(): void {}
}

// showPlanDecision 写入固定位置的计划文件，并显示计划确认组件。
export async function showPlanDecision(ctx: ExtensionContext, planText: string, file?: PlanFile): Promise<PlanReview> {
	const savedFile = savePlanFile(ctx.cwd, planText, file);
	const decision = await ctx.ui.custom<PlanDecision>(
		(_tui, theme, _keybindings, done) => new PlanDecisionPage(theme, done, savedFile?.path),
		{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", margin: { left: 0, right: 0, bottom: 0 } } },
	);
	return { decision, file: savedFile };
}
