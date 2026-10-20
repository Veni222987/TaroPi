import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { emptyState, type WorkflowState } from "./types.ts";

const SCHEMA_VERSION = 1;
const PHASES = new Set(["planning", "clarifying", "implementing"]);

// planStatePath 返回独立于会话记录的工作流状态文件路径。
export function planStatePath(cwd: string, sessionId: string): string {
	const name = /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : createHash("sha256").update(sessionId).digest("hex");
	return path.resolve(cwd, ".pi", "taropi", "plan", `${name}.json`);
}

// loadPlanState 读取工作流状态，缺失、损坏或版本不匹配时降级为空闲。
export function loadPlanState(filePath: string): WorkflowState {
	try {
		const data: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!isRecord(data) || data.version !== SCHEMA_VERSION || !isRecord(data.state)) return emptyState();
		const state = data.state;
		if (typeof state.phase !== "string" || !PHASES.has(state.phase) ||
			typeof state.task !== "string" || !state.task.trim() || typeof state.planText !== "string" ||
			typeof state.adjustmentRounds !== "number" || !Number.isSafeInteger(state.adjustmentRounds) || state.adjustmentRounds < 0) return emptyState();
		const result: WorkflowState = {
			phase: state.phase as WorkflowState["phase"], task: state.task,
			planText: state.planText, adjustmentRounds: state.adjustmentRounds,
		};
		if (state.planFile !== undefined) {
			if (!isRecord(state.planFile) || typeof state.planFile.path !== "string" || typeof state.planFile.createdAt !== "string") return emptyState();
			const createdAt = new Date(state.planFile.createdAt);
			const plansDir = path.resolve(path.dirname(filePath), "..", "plans");
			if (!Number.isFinite(createdAt.getTime()) || path.dirname(state.planFile.path) !== plansDir || path.extname(state.planFile.path) !== ".md") return emptyState();
			result.planFile = { path: state.planFile.path, createdAt };
		}
		return result;
	} catch {
		return emptyState();
	}
}

// savePlanState 原子写入带版本号的状态，空闲时清理文件，失败时返回 false。
export function savePlanState(filePath: string, state: WorkflowState): boolean {
	if (state.phase === "idle") return clearPlanState(filePath);
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(tempPath, JSON.stringify({ version: SCHEMA_VERSION, state }), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tempPath, filePath);
		return true;
	} catch {
		return false;
	} finally {
		try { fs.rmSync(tempPath, { force: true }); } catch { /* 清理失败不影响内存状态。 */ }
	}
}

// clearPlanState 清理已结束的工作流状态，缺失时视为成功。
export function clearPlanState(filePath: string): boolean {
	try {
		fs.rmSync(filePath, { force: true });
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
