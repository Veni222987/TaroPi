import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { PlanDocument, PlanFile, PlanMetadata, PlanStatus, WorkflowState } from "./types.ts";

const PLAN_DIRECTORY = [".pi", "taropi", "plans"] as const;
const SCHEMA = 1;
const STATUSES: PlanStatus[] = ["planning", "implementing", "completed", "exited"];

// createPlanFile 分配固定路径和元数据，短标题不替代原始任务。
export function createPlanFile(cwd: string, sessionId: string, task: string, date = new Date(), title = task): PlanFile {
	return {
		path: planFilePath(cwd, title, date),
		metadata: { schema: SCHEMA, sessionId, status: "planning", task, adjustmentRounds: 0, pendingLaunch: false,
			createdAt: date.toISOString(), updatedAt: date.toISOString() },
	};
}

// publishPlanFile 排他发布完整的初始 Markdown，重名或失败时不修改已有文件。
export function publishPlanFile(file: PlanFile): "created" | "exists" | "failed" {
	const temporaryPath = `${file.path}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file.path), { recursive: true });
		fs.writeFileSync(temporaryPath, renderPlanFile(file.metadata, ""), { encoding: "utf8", flag: "wx", mode: 0o600 });
		fs.linkSync(temporaryPath, file.path);
		return "created";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EEXIST" ? "exists" : "failed";
	} finally {
		try { fs.unlinkSync(temporaryPath); } catch { /* 临时文件可能未创建成功。 */ }
	}
}

// savePlanFile 原子写入元数据和正文，失败时保留原文件并返回 false。
export function savePlanFile(state: WorkflowState, status: PlanStatus, result?: string): boolean {
	const file = state.planFile;
	if (!file) return false;
	const metadata: PlanMetadata = { ...file.metadata, status, task: state.task,
		adjustmentRounds: state.adjustmentRounds, pendingLaunch: state.pendingLaunch, updatedAt: new Date().toISOString() };
	const temporaryPath = `${file.path}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file.path), { recursive: true });
		fs.writeFileSync(temporaryPath, renderPlanFile(metadata, state.planText, result), { encoding: "utf8", flag: "wx", mode: 0o600 });
		fs.renameSync(temporaryPath, file.path);
		file.metadata = metadata;
		return true;
	} catch {
		return false;
	} finally {
		try { fs.unlinkSync(temporaryPath); } catch { /* 临时文件可能已经被 rename。 */ }
	}
}

// findActivePlan 按会话扫描有效活动计划，只为选中的文档提取正文。
export function findActivePlan(cwd: string, sessionId: string): PlanDocument | undefined {
	try {
		const directory = path.resolve(cwd, ...PLAN_DIRECTORY);
		let selected: { file: PlanFile; content: string } | undefined;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			try {
				const filePath = path.join(directory, entry.name);
				const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
				const metadata = readMetadata(content);
				if (!metadata || metadata.sessionId !== sessionId || !["planning", "implementing"].includes(metadata.status)) continue;
				const detailsStart = content.indexOf("\n## 计划详情\n");
				if (detailsStart < 0 || (metadata.status === "implementing" && !hasPlanSteps(content.slice(detailsStart)))) continue;
				if (!selected || Date.parse(metadata.updatedAt) > Date.parse(selected.file.metadata.updatedAt)
					|| (metadata.updatedAt === selected.file.metadata.updatedAt && filePath > selected.file.path)) {
					selected = { file: { path: filePath, metadata }, content };
				}
			} catch {
				// 单个文件损坏不能阻断其余计划恢复。
			}
		}
		if (!selected) return undefined;
		const body = parseFrontmatter(selected.content).body;
		const marker = "\n## 计划详情\n";
		const start = body.indexOf(marker);
		if (start < 0) return undefined;
		const text = body.slice(start + marker.length).trim();
		if (selected.file.metadata.status === "implementing" && !hasPlanSteps(text)) return undefined;
		return { file: selected.file, planText: text === "尚未提交" ? "" : text };
	} catch {
		return undefined;
	}
}

// renderPlanFile 把机器元数据与可读计划正文写入同一 Markdown。
export function renderPlanFile(metadata: PlanMetadata, planText: string, result?: string): string {
	const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
	return ["---", frontmatter, "---", "", `# ${planText ? planTitle(planText) : safeFileNamePart(metadata.task)}`,
		"", "## 计划详情", "", planText.trim() || "尚未提交", "",
		...(result ? ["## 实施结果", "", result.trim(), ""] : []),
	].join("\n");
}

// hasPlanSteps 检查计划是否含有非空编号步骤。
export function hasPlanSteps(text: string): boolean {
	return /^\s*\d+[.)]\s+\S.*/m.test(text);
}

// planTitle 从完整计划中提取展示标题，不改变既有文件名。
export function planTitle(planText: string): string {
	const match = planText.match(/^\s*(?:\*{1,2})?(?:计划标题|标题)(?:\*{1,2})?\s*[：:]\s*(.+?)\s*$/m)
		?? planText.match(/^\s*(?:\*{1,2})?目标(?:\*{1,2})?\s*[：:]\s*(.+?)\s*$/m);
	return match?.[1]?.trim() || "plan";
}

// safeFileNamePart 清理 Markdown 标记和文件名非法字符，最多保留 20 个 Unicode 字符。
export function safeFileNamePart(value: string, fallback = "plan"): string {
	const firstLine = value.split(/\r\n?|\n/).find((line) => line.trim()) ?? "";
	const normalized = firstLine.trim().replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "").replace(/[\\/:：*?"<>|\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, "-").replace(/-+/g, "-");
	return Array.from(normalized.replace(/^[.\s-]+|[.\s-]+$/g, "")).slice(0, 20).join("").replace(/[.\s-]+$/g, "") || fallback;
}

// planFilePath 使用短标题和本地分钟生成固定文件名，冲突由首次发布拒绝。
export function planFilePath(cwd: string, title: string, date: Date): string {
	const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
	const timestamp = parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
	return path.resolve(cwd, ...PLAN_DIRECTORY, `${safeFileNamePart(title)}-${timestamp}.md`);
}

function readMetadata(content: string): PlanMetadata | undefined {
	const header = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
	if (!header) return undefined;
	const value: unknown = parseFrontmatter(header).frontmatter;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const status = STATUSES.find((candidate) => candidate === data.status);
	if (data.schema !== SCHEMA || typeof data.sessionId !== "string" || !data.sessionId
		|| typeof data.task !== "string" || !data.task.trim()
		|| !status
		|| typeof data.adjustmentRounds !== "number" || !Number.isSafeInteger(data.adjustmentRounds) || data.adjustmentRounds < 0
		|| typeof data.pendingLaunch !== "boolean"
		|| (data.pendingLaunch && data.status !== "implementing")
		|| typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))
		|| typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) return undefined;
	return { schema: SCHEMA, sessionId: data.sessionId, status, task: data.task, adjustmentRounds: data.adjustmentRounds,
		pendingLaunch: data.pendingLaunch, createdAt: data.createdAt, updatedAt: data.updatedAt };
}
