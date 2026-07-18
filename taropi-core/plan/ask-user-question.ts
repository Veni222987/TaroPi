/**
 * /plan 澄清阶段的选择框
 *
 * 不依赖 LLM 主动调用 ask_user_question 工具，直接用一个自绘的 ctx.ui.custom
 * 弹窗触发状态流转。渲染风格照抄 rpiv-ask-user-question 的 WrappingSelect
 * （见该包 view/components/wrapping-select.ts）：扁平编号列表 + ❯ 指针 +
 * 灰色描述行，不用 ASCII 边框盒子；「补充内容」这一行落焦即直接变成行内输入框
 * （同款 CURSOR_MARKER + 反显光标技术），不用跳出去另开弹窗或常规输入框。
 */

import { CURSOR_MARKER, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ADJUST_PLAN_LABEL, EXECUTE_PLAN_LABEL } from "./utils.ts";

export interface PlanDecision {
	execute: boolean;
	feedback?: string;
}

// isPrintableInput 判断一段输入是否应当作为可见字符追加进文本框
// （排除 ASCII 控制字符/DEL，其余含中文等多字节字符、粘贴文本一律放行）
function isPrintableInput(data: string): boolean {
	if (data.length === 0) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

interface Row {
	label: string;
	description: string;
}

const ROWS: Row[] = [
	{ label: EXECUTE_PLAN_LABEL, description: "直接进入实施阶段，按步骤并行派发 developer agent" },
	{ label: ADJUST_PLAN_LABEL, description: "移到此行直接输入调整意见，回车提交（可留空）" },
];

/**
 * 计划澄清选择框：两行——「开始实现」直接确认，「补充内容」落焦即可输入。
 * ↑↓ 切换焦点，Enter 确认当前行，Esc 视为不实施且不带反馈。
 */
export class PlanDecisionPage {
	private selected: 0 | 1 = 0;
	private buffer = "";

	constructor(
		private theme: Theme,
		private onDecide: (decision: PlanDecision) => void,
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
			if (this.selected === 0) this.onDecide({ execute: true });
			else this.onDecide({ execute: false, feedback: this.buffer.trim() || undefined });
			return;
		}
		if (this.selected !== 1) return; // 只有「补充内容」行落焦时才接受文本输入

		if (matchesKey(data, Key.backspace)) {
			this.buffer = this.buffer.slice(0, -1);
			return;
		}
		if (isPrintableInput(data)) this.buffer += data;
	}

	render(_width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold("计划已生成，如何继续？"));
		lines.push("");

		for (let i = 0; i < ROWS.length; i++) {
			const row = ROWS[i]!;
			const isActive = i === this.selected;
			const pointer = isActive ? "❯ " : "  ";
			const number = `${i + 1}. `;

			if (i === 1 && isActive) {
				// 落焦「补充内容」：整行变成行内输入框，光标用反显（同 rpiv-ask-user-question 的技术）
				const cursor = `${CURSOR_MARKER}\x1b[7m \x1b[27m`;
				lines.push(this.theme.fg("accent", `${pointer}${number}${row.label}：${this.buffer}${cursor}`));
			} else {
				const line = `${pointer}${number}${row.label}`;
				lines.push(isActive ? this.theme.fg("accent", line) : line);
			}
			lines.push(`    ${this.theme.fg("dim", row.description)}`);
		}

		lines.push("");
		lines.push(this.theme.fg("dim", "Enter 确认 · ↑/↓ 切换 · Esc 取消"));
		return lines;
	}

	invalidate(): void {}
}

// askPlanDecision 弹出选择框询问用户对当前计划的决定
export async function askPlanDecision(ctx: ExtensionContext): Promise<PlanDecision> {
	return ctx.ui.custom<PlanDecision>(
		(_tui, theme, _keybindings, done) => new PlanDecisionPage(theme, (decision) => done(decision)),
		{
			overlay: true,
			overlayOptions: { anchor: "bottom-center", width: "100%", margin: { left: 0, right: 0, bottom: 0 } },
		},
	);
}
