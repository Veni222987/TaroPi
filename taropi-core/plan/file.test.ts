import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanFile, findActivePlan, hasPlanSteps, planFilePath, planTitle, publishPlanFile, renamePlanFile, renderPlanFile, safeFileNamePart, savePlanFile } from "./file.ts";
import type { WorkflowState } from "./types.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync), linkSync: vi.fn(actual.linkSync), unlinkSync: vi.fn(actual.unlinkSync) };
});

const directories: string[] = [];
const PLAN = "目标：修复\nPlan:\n计划标题：缓存验证\n1. 检查边界\n风险：无";
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function tempDir(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-file-")); directories.push(directory); return directory; }
let sequence = 0;
function state(cwd: string, sessionId = "session-a"): WorkflowState {
	const task = '任务：含"引号"\n---\n中文';
	const planFile = createPlanFile(cwd, sessionId, task, new Date(), `测试-${sequence++}`);
	expect(publishPlanFile(planFile)).toBe("created");
	return { phase: "planning", task, planText: "", adjustmentRounds: 0, pendingLaunch: false, planFile };
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
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("拒绝写入"); });
		current.planText = PLAN;
		expect(savePlanFile(current, "planning")).toBe(false);
		expect(fs.readFileSync(current.planFile!.path, "utf8")).toBe(before);
		expect(fs.readdirSync(path.dirname(current.planFile!.path))).toHaveLength(1);
	});
	it("目录缺失、不可用时安全失败，分钟内路径确定", () => {
		const cwd = tempDir(); expect(findActivePlan(cwd, "session-a")).toBeUndefined();
		fs.writeFileSync(path.join(cwd, ".pi"), "不是目录");
		const date = new Date(2026, 9, 20, 0, 0);
		expect(publishPlanFile(createPlanFile(cwd, "session-a", "任务", date))).toBe("failed");
		expect(planFilePath(cwd, "同一任务", date)).toBe(planFilePath(cwd, "同一任务", date));
	});
	it.each([
		[new Date(2026, 0, 1, 0, 3, 59, 999), "任务-2026-01-01-00-03.md"],
		[new Date(2026, 11, 31, 23, 59), "任务-2026-12-31-23-59.md"],
		[new Date(2027, 0, 1, 0, 0), "任务-2027-01-01-00-00.md"],
	])("使用本地日历和分钟补零 %s", (date, expected) => {
		expect(path.basename(planFilePath(tempDir(), "任务", date))).toBe(expected);
	});
	it("并发竞争仅发布一个完整文件，清理后同名和已完成历史均拒绝覆盖", async () => {
		const cwd = tempDir(); const date = new Date(2026, 9, 21, 23, 30);
		const candidates = Array.from({ length: 10 }, (_, index) => createPlanFile(cwd, `session-${index}`, `原始任务-${index}`, date, index % 2 ? "# 同/名" : "同名"));
		const results = await Promise.all(candidates.map(async (file) => publishPlanFile(file)));
		expect(results.filter((value) => value === "created")).toHaveLength(1);
		expect(results.filter((value) => value === "exists")).toHaveLength(9);
		const file = candidates[0]!;
		const before = fs.readFileSync(file.path, "utf8");
		expect(parseFrontmatter(before).frontmatter.task).toBe("原始任务-0");
		expect(fs.readdirSync(path.dirname(file.path))).toEqual([path.basename(file.path)]);
		fs.writeFileSync(file.path, renderPlanFile({ ...file.metadata, status: "completed" }, PLAN));
		const completed = fs.readFileSync(file.path, "utf8");
		expect(publishPlanFile(candidates[1]!)).toBe("exists");
		expect(fs.readFileSync(file.path, "utf8")).toBe(completed);
		expect(publishPlanFile(createPlanFile(cwd, "session-next", "任务", new Date(2026, 9, 21, 23, 31), "同名"))).toBe("created");
	});
	it("符号链接目标不覆盖，排他发布失败也不退化为 rename", () => {
		const cwd = tempDir(); const file = createPlanFile(cwd, "session-a", "任务");
		fs.mkdirSync(path.dirname(file.path), { recursive: true });
		const target = path.join(cwd, "target.md"); fs.writeFileSync(target, "保留");
		fs.symlinkSync(target, file.path);
		expect(publishPlanFile(file)).toBe("exists");
		expect(fs.readFileSync(target, "utf8")).toBe("保留");
		expect(fs.lstatSync(file.path).isSymbolicLink()).toBe(true);
		fs.unlinkSync(file.path);
		vi.spyOn(fs, "linkSync").mockImplementationOnce(() => { throw Object.assign(new Error("不支持"), { code: "ENOTSUP" }); });
		expect(publishPlanFile(file)).toBe("failed");
		expect(fs.readdirSync(path.dirname(file.path))).toEqual([]);
		expect(fs.renameSync).not.toHaveBeenCalled();
	});
	it("旧命名仍由 frontmatter 恢复，更新不迁移旧路径", () => {
		const cwd = tempDir(); const current = state(cwd); current.planText = PLAN;
		const oldPath = path.join(path.dirname(current.planFile!.path), "冗长任务-20261021T153014576-b3ebee4f.md");
		fs.renameSync(current.planFile!.path, oldPath); current.planFile!.path = oldPath;
		expect(savePlanFile(current, "planning")).toBe(true);
		expect(findActivePlan(cwd, "session-a")?.file.path).toBe(oldPath);
	});
	it("submit 改名保留创建分钟，修订标题可再次改名且恢复只找到一个文件", () => {
		const cwd = tempDir(); const current = state(cwd); current.planText = PLAN;
		current.planFile!.metadata.createdAt = new Date(2026, 9, 22, 22, 55).toISOString();
		expect(savePlanFile(current, "planning")).toBe(true);
		const originalPath = current.planFile!.path;
		const originalContent = fs.readFileSync(originalPath, "utf8");
		expect(renamePlanFile(cwd, current.planFile!, PLAN)).toBe("renamed");
		const first = current.planFile!.path;
		expect(path.basename(first)).toBe("缓存验证-2026-10-22-22-55.md");
		expect(fs.existsSync(originalPath)).toBe(false); expect(fs.readFileSync(first, "utf8")).toBe(originalContent);
		expect(renamePlanFile(cwd, current.planFile!, PLAN)).toBe("unchanged");
		current.planText = PLAN.replace("缓存验证", "修订后的标题"); savePlanFile(current, "planning");
		expect(renamePlanFile(cwd, current.planFile!, current.planText)).toBe("renamed");
		expect(path.basename(current.planFile!.path)).toBe("修订后的标题-2026-10-22-22-55.md");
		expect(fs.existsSync(first)).toBe(false);
		expect(findActivePlan(cwd, "session-a")).toMatchObject({ planText: current.planText, file: { path: current.planFile!.path } });
		expect(fs.readdirSync(path.dirname(first))).toEqual([path.basename(current.planFile!.path)]);
	});
	it.each(["目标：不是标题\n1. 修改", "计划标题：\n1. 修改", "计划标题：/:*?<>|\n1. 修改"])("缺失或非法明确标题不改名：%s", (text) => {
		const cwd = tempDir(); const current = state(cwd); const original = current.planFile!.path;
		expect(renamePlanFile(cwd, current.planFile!, text)).toBe("unchanged");
		expect(current.planFile!.path).toBe(original); expect(fs.existsSync(original)).toBe(true);
	});
	it("合法 plan 标题可改名，非法创建时间不改名", () => {
		const cwd = tempDir(); const current = state(cwd);
		expect(renamePlanFile(cwd, current.planFile!, "计划标题：plan")).toBe("renamed");
		const original = current.planFile!.path;
		current.planFile!.metadata.createdAt = "bad";
		expect(renamePlanFile(cwd, current.planFile!, PLAN)).toBe("failed");
		expect(current.planFile!.path).toBe(original);
	});
	it.each(["implementing", "completed", "exited"] as const)("%s 阶段即使标题变更也不改名", (status) => {
		const cwd = tempDir(); const current = state(cwd); const original = current.planFile!.path;
		savePlanFile(current, status);
		expect(renamePlanFile(cwd, current.planFile!, PLAN)).toBe("unchanged");
		expect(current.planFile!.path).toBe(original);
	});
	it.each([false, true])("改名目标已存在不覆盖，包括符号链接：%s", (symlink) => {
		const cwd = tempDir(); const current = state(cwd); current.planText = PLAN; savePlanFile(current, "planning");
		const file = current.planFile!; const original = file.path; const before = fs.readFileSync(original, "utf8");
		const target = planFilePath(cwd, "缓存验证", new Date(file.metadata.createdAt));
		if (symlink) { const other = path.join(cwd, "other.md"); fs.writeFileSync(other, "不覆盖"); fs.symlinkSync(other, target); }
		else fs.writeFileSync(target, "不覆盖");
		expect(renamePlanFile(cwd, file, PLAN)).toBe("exists");
		expect(file.path).toBe(original); expect(fs.readFileSync(original, "utf8")).toBe(before);
		expect(fs.readFileSync(target, "utf8")).toBe("不覆盖");
		if (symlink) expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
	});
	it("link 失败不使用覆盖 rename，unlink 失败回滚目标链接", () => {
		const cwd = tempDir(); const current = state(cwd); const file = current.planFile!; const original = file.path;
		vi.spyOn(fs, "linkSync").mockImplementationOnce(() => { throw new Error("link 不支持"); });
		expect(renamePlanFile(cwd, file, PLAN)).toBe("failed");
		expect(file.path).toBe(original); expect(fs.existsSync(original)).toBe(true);
		vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw new Error("旧文件删除失败"); });
		expect(renamePlanFile(cwd, file, PLAN)).toBe("failed");
		expect(file.path).toBe(original); expect(fs.readdirSync(path.dirname(original))).toEqual([path.basename(original)]);
	});
	it("回滚不删除被其他进程替换成不同 inode 的目标", async () => {
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		const cwd = tempDir(); const current = state(cwd); const file = current.planFile!; const original = file.path;
		const target = planFilePath(cwd, "缓存验证", new Date(file.metadata.createdAt));
		vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
			actual.unlinkSync(target); fs.writeFileSync(target, "其他进程的文件"); throw new Error("原路径删除失败");
		});
		expect(renamePlanFile(cwd, file, PLAN)).toBe("failed");
		expect(file.path).toBe(original); expect(fs.existsSync(original)).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe("其他进程的文件");
	});
	it("unlink 和回滚均失败时仍保留原路径，残留同内容链接可以恢复", () => {
		const cwd = tempDir(); const current = state(cwd); const file = current.planFile!; const original = file.path;
		vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw new Error("失败"); }).mockImplementationOnce(() => { throw new Error("回滚失败"); });
		expect(renamePlanFile(cwd, file, PLAN)).toBe("failed");
		expect(file.path).toBe(original); expect(fs.existsSync(original)).toBe(true);
		expect(fs.readdirSync(path.dirname(original))).toHaveLength(2);
		expect(findActivePlan(cwd, "session-a")).toBeDefined();
	});
	it("文件名、标题和计划编号处理边界", () => {
		expect(safeFileNamePart(".. /:*?\"<>| ")).toBe("plan");
		expect(Array.from(safeFileNamePart("鹅".repeat(100)))).toHaveLength(20);
		expect(safeFileNamePart("\n## 短标题 -- 测试 /:*?\"<>|.\n忽略下一行")).toBe("短标题-测试");
		expect(safeFileNamePart(`${"鹅".repeat(19)}.多余`)).toBe("鹅".repeat(19));
		expect(safeFileNamePart("1. `修复功能`")).toBe("修复功能");
		expect(planTitle("计划标题：中文标题")).toBe("中文标题");
		expect(planTitle("无标题")).toBe("plan");
		expect(hasPlanSteps("Plan:\n1. 实施")).toBe(true);
		expect(hasPlanSteps("没有步骤\n1. ")).toBe(false);
	});
});
