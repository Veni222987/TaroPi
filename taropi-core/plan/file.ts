import * as fs from "node:fs";
import * as path from "node:path";

const PLAN_DIRECTORY = [".pi", "taropi", "plans"] as const;

export type PlanFileStatus = "clarifying" | "implementing" | "completed";

const STATUS_LABEL: Record<PlanFileStatus, string> = {
	clarifying: "❔ 澄清确认中",
	implementing: "▶ 主 Agent 实施中",
	completed: "✓ 已完成",
};

export interface PlanFile {
	path: string;
	createdAt: Date;
}

function formatTimestamp(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19);
}

// planTitle 从计划文本中提取用于展示和文件命名的标题。
export function planTitle(planText: string): string {
	const match = planText.match(/^\s*(?:\*{1,2})?(?:计划标题|标题|目标)(?:\*{1,2})?\s*[：:]\s*(.+?)\s*$/m);
	return match?.[1]?.trim() || "plan";
}

// safeFileNamePart 清理文件名中的非法字符并限制长度。
export function safeFileNamePart(value: string): string {
	const normalized = value
		.replace(/[\\/:：*?"<>|\u0000-\u001f]/g, "")
		.replace(/\s+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "");
	return Array.from(normalized).slice(0, 48).join("") || "plan";
}

// renderPlanFile 生成包含状态信息的计划 Markdown 内容。
export function renderPlanFile(planText: string, createdAt: Date, status: PlanFileStatus, updatedAt = new Date()): string {
	return [
		`# ${planTitle(planText)}`,
		"",
		`**创建时间**: ${formatTimestamp(createdAt)}`,
		`**更新时间**: ${formatTimestamp(updatedAt)}`,
		`**状态**: ${STATUS_LABEL[status]}`,
		"",
		"## 计划详情",
		"",
		planText.trim(),
		"",
	].join("\n");
}

// planFilePath 返回当前工作目录下的计划文件绝对路径。
export function planFilePath(cwd: string, planText: string, date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return path.resolve(cwd, ...PLAN_DIRECTORY, `${safeFileNamePart(planTitle(planText))}-${timestamp}.md`);
}

// savePlanFile 写入计划文件，文件系统异常时返回 undefined。
export function savePlanFile(cwd: string, planText: string, file?: PlanFile): PlanFile | undefined {
	try {
		const createdAt = new Date();
		const current = file ?? { path: planFilePath(cwd, planText, createdAt), createdAt };
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
