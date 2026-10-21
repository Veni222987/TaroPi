export type Phase = "idle" | "planning" | "implementing";
export type PlanStatus = "planning" | "implementing" | "completed" | "exited";
export type PlanAction = "status" | "submit" | "complete" | "exit";

export interface PhaseConfig {
	model?: string;
	blockedTools: string[];
	prompt: string;
}

export type PlanConfig = Record<Phase, PhaseConfig>;

export interface PlanMetadata {
	schema: number;
	sessionId: string;
	status: PlanStatus;
	task: string;
	adjustmentRounds: number;
	pendingLaunch: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PlanFile {
	path: string;
	metadata: PlanMetadata;
}

export interface PlanDocument {
	file: PlanFile;
	planText: string;
}

export interface WorkflowState {
	phase: Phase;
	task: string;
	planText: string;
	planFile?: PlanFile;
	adjustmentRounds: number;
	pendingLaunch: boolean;
}

export interface PlanRequest {
	action: PlanAction;
	text?: string;
}

export interface PlanResult {
	text: string;
	terminate?: boolean;
}
