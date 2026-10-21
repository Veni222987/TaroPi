import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { IDLE_PROMPT, IMPLEMENTING_PROMPT, PLANNING_PROMPT } from "./prompts.ts";
import type { Phase, PlanConfig } from "./types.ts";

const DEFAULT_CONFIG: PlanConfig = {
	idle: { blockedTools: [], prompt: IDLE_PROMPT },
	planning: { model: "Au", blockedTools: ["edit", "write"], prompt: PLANNING_PROMPT },
	implementing: { model: "Ag", blockedTools: [], prompt: IMPLEMENTING_PROMPT },
};
const PHASES: Phase[] = ["idle", "planning", "implementing"];

// loadPlanConfig 按阶段和字段合并用户配置，非法字段独立回退到默认值。
export function loadPlanConfig(filePath = join(getAgentDir(), "plan.json")): PlanConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	try {
		const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isRecord(raw)) return config;
		for (const phase of PHASES) {
			const value = raw[phase];
			if (!isRecord(value)) continue;
			if (typeof value.model === "string" && value.model.trim()) config[phase].model = value.model.trim();
			if (value.model === null) delete config[phase].model;
			if (typeof value.prompt === "string" && value.prompt.trim()) config[phase].prompt = value.prompt;
			if (Array.isArray(value.blockedTools) && value.blockedTools.every((tool) => typeof tool === "string" && tool.trim())) {
				config[phase].blockedTools = [...new Set(value.blockedTools.map((tool: string) => tool.trim()))];
			}
		}
	} catch {
		// 缺失或损坏时使用默认配置。
	}
	return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
