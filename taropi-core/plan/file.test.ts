import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planFilePath, planTitle, renderPlanFile, safeFileNamePart, savePlanFile, updatePlanFile } from "./file.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-plan-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("计划文件", () => {
	it("提取标题并生成安全文件名", () => {
		const plan = "计划标题：计划 / 模式：优化\n1. 调整流程";
		expect(planTitle(plan)).toBe("计划 / 模式：优化");
		expect(safeFileNamePart(planTitle(plan))).toBe("计划-模式优化");
		expect(planFilePath("/workspace", plan, new Date(2026, 0, 2, 3, 4, 5))).toMatch(/计划-模式优化-20260102T030405\.md$/);
	});

	it("写入、更新并保留计划文件路径", () => {
		const plan = "计划标题：单测基础\n1. 添加 Vitest";
		const file = savePlanFile(tempDir(), plan);
		expect(file).toBeDefined();
		expect(fs.readFileSync(file!.path, "utf-8")).toContain("❔ 澄清确认中");
		updatePlanFile(file, plan, "completed");
		expect(fs.readFileSync(file!.path, "utf-8")).toContain("✓ 已完成");
	});

	it("渲染内容包含标题、状态和计划详情", () => {
		const output = renderPlanFile("计划标题：验证\n1. 运行测试", new Date("2026-01-01T00:00:00Z"), "implementing", new Date("2026-01-01T01:00:00Z"));
		expect(output).toContain("# 验证");
		expect(output).toContain("▶ 主 Agent 实施中");
		expect(output).toContain("1. 运行测试");
	});
});
