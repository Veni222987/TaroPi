import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlanState, loadPlanState, planStatePath, savePlanState } from "./store.ts";
import { emptyState, type WorkflowState } from "./types.ts";

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-plan-state-")); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

function activeState(): WorkflowState {
	return { ...emptyState(), phase: "clarifying", task: "修复计划", planText: "1. 修复", adjustmentRounds: 1,
		planFile: { path: path.join(cwd, ".pi/taropi/plans/修复.md"), createdAt: new Date("2026-01-01T00:00:00Z") } };
}

describe("独立计划状态文件", () => {
	it("原子写入带版本号的状态并恢复 Date", () => {
		const file = planStatePath(cwd, "session-1");
		const state = activeState();
		expect(savePlanState(file, state)).toBe(true);
		expect(loadPlanState(file)).toEqual(state);
		expect(JSON.parse(fs.readFileSync(file, "utf-8")).version).toBe(1);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["session-1.json"]);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(savePlanState(file, emptyState())).toBe(true);
		expect(fs.existsSync(file)).toBe(false);
		expect(clearPlanState(file)).toBe(true);
	});

	it("缺失、损坏、未知版本和非法状态降级为空闲", () => {
		const file = planStatePath(cwd, "session-2");
		expect(loadPlanState(file)).toEqual(emptyState());
		fs.mkdirSync(path.dirname(file), { recursive: true });
		for (const data of ["{", "null", JSON.stringify({ version: 99, state: activeState() }),
			JSON.stringify({ version: 1, state: { ...activeState(), adjustmentRounds: -1 } }),
			JSON.stringify({ version: 1, state: { ...activeState(), phase: "unknown" } }),
			JSON.stringify({ version: 1, state: { ...activeState(), planFile: { path: "/outside.md", createdAt: "invalid" } } })]) {
			fs.writeFileSync(file, data);
			expect(loadPlanState(file)).toEqual(emptyState());
		}
	});

	it("自定义会话 ID 不允许路径穿越", () => {
		for (const id of ["../../outside", "", "a/b", "中文会话"]) {
			expect(path.dirname(planStatePath(cwd, id))).toBe(path.join(cwd, ".pi/taropi/plan"));
		}
	});

	it("写入失败安全降级且不遗留临时文件", () => {
		const blocked = path.join(cwd, "blocked");
		fs.writeFileSync(blocked, "不是目录");
		expect(savePlanState(path.join(blocked, "state.json"), activeState())).toBe(false);
		expect(loadPlanState(path.join(blocked, "state.json"))).toEqual(emptyState());
		expect(fs.readdirSync(cwd)).toEqual(["blocked"]);
	});
});
