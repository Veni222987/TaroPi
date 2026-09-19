import * as fs from "node:fs";
import * as path from "node:path";
import { CURSOR_MARKER, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const PLAN_DIRECTORY = [".pi", "taropi", "plans"] as const;
const EXECUTE_PLAN_LABEL = "开始实施";
const ADJUST_PLAN_LABEL = "补充内容";

type PlanFileStatus = "clarifying" | "implementing" | "completed";

const STATUS_LABEL: Record<PlanFileStatus, string> = {
	clarifying: "❔ 澄清确认中",
	implementing: "▶ 主 Agent 实施中",
	completed: "✓ 已完成",
};

export interface PlanFile {
	path: string;
	createdAt: Date;
}

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

function formatTimestamp(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function planTitle(planText: string): string {
	const match = planText.match(/^\s*(?:\*{1,2})?(?:计划标题|标题|目标)(?:\*{1,2})?\s*[：:]\s*(.+?)\s*$/m);
	return match?.[1]?.trim() || "plan";
}

function safeFileNamePart(value: string): string {
	const normalized = value
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.replace(/\s+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "");
	return Array.from(normalized).slice(0, 48).join("") || "plan";
}

function renderPlanFile(planText: string, createdAt: Date, status: PlanFileStatus): string {
	return [
		`# ${planTitle(planText)}`,
		"",
		`**创建时间**: ${formatTimestamp(createdAt)}`,
		`**更新时间**: ${formatTimestamp(new Date())}`,
		`**状态**: ${STATUS_LABEL[status]}`,
		"",
		"## 计划详情",
		"",
		planText.trim(),
		"",
	].join("\n");
}

function planFileName(planText: string, date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `${safeFileNamePart(planTitle(planText))}-${timestamp}.md`;
}

function savePlanFile(cwd: string, planText: string, file?: PlanFile): PlanFile | undefined {
	try {
		const createdAt = new Date();
		const current = file ?? { path: path.resolve(cwd, ...PLAN_DIRECTORY, planFileName(planText, createdAt)), createdAt };
		fs.mkdirSync(path.dirname(current.path), { recursive: true });
		fs.writeFileSync(current.path, renderPlanFile(planText, current.createdAt, "clarifying"), "utf-8");
		return current;
	} catch {
		return undefined;
	}
}

// updatePlanFile 更新计划文件当前状态。
export function updatePlanFile(file: PlanFile | undefined, planText: string, status: PlanFileStatus): void {
	if (!file) return;
	try {
		fs.writeFileSync(file.path, renderPlanFile(planText, file.createdAt, status), "utf-8");
	} catch {
		// 计划流程不因文件系统异常中断。
	}
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
		lines.push(
			this.theme.fg(
				"dim",
				this.planPath ? `计划文件已保存至：${this.planPath}` : `计划文件未能写入：${PLAN_DIRECTORY.join("/")}`,
			),
		);
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
		{
			overlay: true,
			overlayOptions: { anchor: "bottom-center", width: "100%", margin: { left: 0, right: 0, bottom: 0 } },
		},
	);
	return { decision, file: savedFile };
}
