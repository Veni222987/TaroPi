import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanFile, findActivePlan, hasPlanSteps, planFilePath, planTitle, renderPlanFile, safeFileNamePart, savePlanFile } from "./file.ts";
import type { WorkflowState } from "./types.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const directories: string[] = [];
const PLAN = "目标：修复\nPlan:\n计划标题：缓存验证\n1. 检查边界\n风险：无";
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function tempDir(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-file-")); directories.push(directory); return directory; }
function state(cwd: string, sessionId = "session-a"): WorkflowState {
	return { phase: "planning", task: '任务：含"引号"\n---\n中文', planText: "", adjustmentRounds: 0, pendingLaunch: false,
		planFile: createPlanFile(cwd, sessionId, '任务：含"引号"\n---\n中文') };
}

describe("Markdown 检查点", () => {
	it("入口创建后可恢复，标题更新不改名，状态与正文一次写出", () => {
		const cwd = tempDir();
		const current = state(cwd);
		expect(savePlanFile(current, "planning")).toBe(true);
		expect(findActivePlan(cwd, "session-a")?.planText).toBe("");
		const originalPath = current.planFile!.path;
		current.planText = PLAN;
		current.phase = "implementing";
		current.pendingLaunch = true;
		current.adjustmentRounds = 2;
		expect(savePlanFile(current, "implementing")).toBe(true);
		const restored = findActivePlan(cwd, "session-a")!;
		expect(restored.planText).toBe(PLAN);
		expect(restored.file.path).toBe(originalPath);
		expect(restored.file.metadata).toMatchObject({ schema: 1, status: "implementing", pendingLaunch: true, adjustmentRounds: 2, task: current.task });
		const content = fs.readFileSync(originalPath, "utf8");
		expect(content).toContain("# 缓存验证");
		expect(content).not.toContain("**状态**");
		expect(parseFrontmatter(content).frontmatter).toEqual(restored.file.metadata);
		expect(fs.readdirSync(path.dirname(originalPath))).toEqual([path.basename(originalPath)]);
	});
	it.each(["completed", "exited"] as const)("%s 留存历史但不再恢复", (status) => {
		const cwd = tempDir(); const current = state(cwd); current.planText = PLAN;
		expect(savePlanFile(current, status, "测试通过")).toBe(true);
		expect(findActivePlan(cwd, "session-a")).toBeUndefined();
		expect(fs.readFileSync(current.planFile!.path, "utf8")).toContain("测试通过");
	});
	it("跳过旧计划、损坏元数据、异会话和临时文件，同会话取最近更新", () => {
		const cwd = tempDir(); const a = state(cwd); const b = state(cwd);
		a.planText = "1. 较早版本"; b.planText = "1. 较新版本";
		savePlanFile(a, "planning"); savePlanFile(b, "planning");
		const directory = path.dirname(a.planFile!.path);
		fs.writeFileSync(a.planFile!.path, renderPlanFile({ ...a.planFile!.metadata, updatedAt: "2020-01-01T00:00:00.000Z" }, a.planText));
		const header = b.planFile!.metadata;
		for (const [index, metadata] of [
			{ ...header, schema: 99 }, { ...header, updatedAt: "bad" }, { ...header, adjustmentRounds: -1 },
			{ ...header, status: "idle" }, { ...header, pendingLaunch: true }, { ...header, sessionId: "session-b" },
		].entries()) fs.writeFileSync(path.join(directory, `bad-${index}.md`), ["---", ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", "", "## 计划详情", "", PLAN].join("\n"));
		fs.writeFileSync(path.join(directory, "old.md"), "# Plan\n**状态**: ▶ 主 Agent 实施中");
		fs.writeFileSync(path.join(directory, "corrupt.md"), "---\nschema: [\n---\n");
		fs.writeFileSync(path.join(directory, "orphan.tmp"), renderPlanFile(header, PLAN));
		fs.writeFileSync(path.join(directory, "bad-body.md"), renderPlanFile({ ...header, updatedAt: "2099-01-01T00:00:00.000Z" }, PLAN).replace("## 计划详情", "## 缺失"));
		expect(findActivePlan(cwd, "session-a")?.planText).toBe("1. 较新版本");
	});
	it("Windows 换行与 BOM 仍可恢复", () => {
		const cwd = tempDir(); const current = state(cwd); current.planText = PLAN;
		savePlanFile(current, "planning");
		const content = fs.readFileSync(current.planFile!.path, "utf8");
		fs.writeFileSync(current.planFile!.path, `\uFEFF${content.replace(/\n/g, "\r\n")}`);
		expect(findActivePlan(cwd, "session-a")?.planText).toBe(PLAN);
	});
	it("损坏正文与实施空正文降级，不把元数据当完整计划", () => {
		const cwd = tempDir(); const current = state(cwd); savePlanFile(current, "planning");
		fs.writeFileSync(current.planFile!.path, renderPlanFile({ ...current.planFile!.metadata, status: "implementing" }, ""));
		expect(findActivePlan(cwd, "session-a")).toBeUndefined();
		fs.writeFileSync(current.planFile!.path, renderPlanFile(current.planFile!.metadata, PLAN).replace("## 计划详情", "## 缺失"));
		expect(findActivePlan(cwd, "session-a")).toBeUndefined();
	});
	it("原子替换失败不损坏原文件，清理临时文件", () => {
		const cwd = tempDir(); const current = state(cwd); savePlanFile(current, "planning");
		const before = fs.readFileSync(current.planFile!.path, "utf8");
		vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("拒绝写入"); });
		current.planText = PLAN;
		expect(savePlanFile(current, "planning")).toBe(false);
		expect(fs.readFileSync(current.planFile!.path, "utf8")).toBe(before);
		expect(fs.readdirSync(path.dirname(current.planFile!.path))).toHaveLength(1);
	});
	it("目录缺失、不可用时降级，固定文件名避免同秒覆盖", () => {
		const cwd = tempDir(); expect(findActivePlan(cwd, "session-a")).toBeUndefined();
		fs.writeFileSync(path.join(cwd, ".pi"), "不是目录");
		expect(savePlanFile(state(cwd), "planning")).toBe(false);
		const date = new Date("2026-10-20T00:00:00Z");
		expect(planFilePath(cwd, "同一任务", date)).not.toBe(planFilePath(cwd, "同一任务", date));
	});
	it("文件名、标题和计划编号处理边界", () => {
		expect(safeFileNamePart(".. /:*?\"<>| ")).toBe("plan");
		expect(Array.from(safeFileNamePart("鹅".repeat(100)))).toHaveLength(48);
		expect(planTitle("计划标题：中文标题")).toBe("中文标题");
		expect(planTitle("无标题")).toBe("plan");
		expect(hasPlanSteps("Plan:\n1. 实施")).toBe(true);
		expect(hasPlanSteps("没有步骤\n1. ")).toBe(false);
	});
});
