import type { PlanFile } from "./file.ts";

export type WorkflowPhase = "idle" | "planning" | "clarifying" | "implementing";

export interface WorkflowState {
	phase: WorkflowPhase;
	task: string;
	planText: string;
	planFile?: PlanFile;
	adjustmentRounds: number;
}

// emptyState 返回空闲的计划工作流状态。
export function emptyState(): WorkflowState {
	return { phase: "idle", task: "", planText: "", adjustmentRounds: 0 };
}
