import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveFilePath, archiveSessionName, archiveSessionFile, renderArchivedSession, renderEmptySession, replaceAtomic, restoreSessionFile, writeExclusive } from "./file.ts";

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-file-")); directories.push(dir);
	const file = path.join(dir, "current.jsonl"), archived = path.join(dir, "old.jsonl");
	fs.writeFileSync(file, "original");
	return { dir, file, archived };
}

describe("归档文件", () => {
	it("本机分钟、Unicode 截断及非法字符，时间无效时拒绝", () => {
		expect(path.basename(archiveFilePath("/tmp", "## 修复/标题", new Date(2026, 9, 23, 20, 45)))).toBe("修复标题-archived-2026-10-23-20-45.jsonl");
		expect(path.basename(archiveFilePath("/tmp", "鹅".repeat(30), new Date()))).toMatch(new RegExp(`^${"鹅".repeat(20)}-archived-`));
		expect(path.basename(archiveFilePath("/tmp", "../:*", new Date()))).toMatch(/^session-archived-/);
		expect(() => archiveFilePath("/tmp", "任务", new Date("bad"))).toThrow("时间无效");
	});
	it.each([["持续工作", "持续工作-修复归档-archived"], [undefined, "修复归档-archived"], ["  ", "修复归档-archived"]])("显示名称保留原名 %j 和活动概括", (name, expected) => {
		expect(archiveSessionName("修复归档", name)).toBe(expected);
		expect(path.basename(archiveFilePath("/tmp", "修复归档", new Date(2026, 9, 23, 20, 45), name))).toBe(`${expected}-2026-10-23-20-45.jsonl`);
	});
	it("长会话名不挤掉活动概括，文件名分别清理和截断两部分", () => {
		const name = "鹅".repeat(30);
		expect(archiveSessionName("活动概括", name)).toBe(`${name}-活动概括-archived`);
		expect(path.basename(archiveFilePath("/tmp", "活动概括", new Date(2026, 9, 23, 20, 45), `## ${name}/:*?`))).toBe(`${"鹅".repeat(20)}-活动概括-archived-2026-10-23-20-45.jsonl`);
	});
	it.each([undefined, "原会话名"])("空会话保留身份、cwd、parentSession 和名称 %s，无消息", (name) => {
		const f = fixture();
		fs.writeFileSync(f.file, renderEmptySession({ id: "original-id", cwd: f.dir, parentSession: "/tmp/parent.jsonl" }, name));
		const manager = SessionManager.open(f.file);
		expect(manager.getSessionId()).toBe("original-id"); expect(manager.getHeader()?.parentSession).toBe("/tmp/parent.jsonl");
		expect(manager.getSessionName()).toBe(name); expect(manager.buildSessionContext().messages).toEqual([]);
		expect(manager.getEntries()).toHaveLength(name ? 1 : 0);
	});
	it("归档只更换 header id 并追加名称，完整原行、活跃分支与 context_edit 可恢复", () => {
		const f = fixture(); const manager = SessionManager.create(f.dir, f.dir);
		const root = manager.appendMessage({ role: "user", content: "共同任务", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "放弃分支", timestamp: 2 });
		manager.branch(root);
		const leaf = manager.appendMessage({ role: "user", content: "当前分支", timestamp: 3 });
		manager.appendContextEdit(leaf, { content: "修改内容" });
		const content = fs.readFileSync(manager.getSessionFile()!, "utf8");
		fs.writeFileSync(f.archived, renderArchivedSession(content, "archive-id", "修复标题", manager.getLeafId()));
		const archived = SessionManager.open(f.archived);
		expect(archived.getSessionId()).toBe("archive-id"); expect(archived.getSessionName()).toBe("修复标题-archived");
		expect(archived.buildSessionContext().messages).toEqual(manager.buildSessionContext().messages);
		expect(fs.readFileSync(f.archived, "utf8").split("\n").slice(1, -2)).toEqual(content.trimEnd().split("\n").slice(1));
	});
	it("保留原始条目尾部空白和空行，无末尾换行时也保持合法 JSONL", () => {
		const header = '{"type":"session","id":"old","version":3,"timestamp":"2026-10-23T00:00:00Z","cwd":"/tmp"}';
		const entry = '{"type":"session_info","id":"entry","parentId":null,"timestamp":"2026-10-23T00:00:00Z","name":"old"}  ';
		for (const suffix of ["", "\n", "\n\n"]) {
			const result = renderArchivedSession(`${header}\n${entry}${suffix}`, "new", "新标题");
			expect(result).toContain(`${entry}${suffix || "\n"}`);
			expect(JSON.parse(result.trimEnd().split("\n").at(-1)!)).toMatchObject({ type: "session_info", parentId: "entry" });
		}
	});
	it.each(["bad", '{"type":"message"}', '{"type":"session"}\ninvalid'])("损坏输入 %s 拒绝归档", (content) => {
		expect(() => renderArchivedSession(content, "new", "title")).toThrow();
	});
	it("排他创建不覆盖，替换和回滚恢复精确内容", () => {
		const f = fixture(); archiveSessionFile(f.file, f.archived, "archive", "empty");
		expect(fs.readFileSync(f.file, "utf8")).toBe("empty");
		expect(() => archiveSessionFile(f.file, f.archived, "overwrite", "other")).toThrow();
		expect(fs.readFileSync(f.archived, "utf8")).toBe("archive"); expect(fs.readFileSync(f.file, "utf8")).toBe("empty");
		restoreSessionFile(f.file, "original", f.archived);
		expect(fs.readFileSync(f.file, "utf8")).toBe("original"); expect(fs.existsSync(f.archived)).toBe(false);
		expect(fs.readdirSync(f.dir)).toEqual(["current.jsonl"]);
	});
	it.each(["archive-write", "temporary-open", "temporary-write", "rename"])("步骤 %s 失败保留原文件且无残留", (step) => {
		const f = fixture();
		if (step === "archive-write" || step === "temporary-write") {
			const original = fs.writeFileSync;
			let count = 0;
			vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
				if (++count === (step === "archive-write" ? 1 : 2)) throw new Error("写入失败");
				return original(...args);
			});
		} else if (step === "temporary-open") {
			const original = fs.openSync;
			vi.spyOn(fs, "openSync").mockImplementation((...args) => {
				if (String(args[0]).endsWith(".tmp")) throw new Error("临时文件失败");
				return original(...args);
			});
		} else vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("替换失败"); });
		expect(() => archiveSessionFile(f.file, f.archived, "archive", "empty")).toThrow();
		expect(fs.readFileSync(f.file, "utf8")).toBe("original"); expect(fs.readdirSync(f.dir)).toEqual(["current.jsonl"]);
	});
	it("恢复失败保留归档，已有排他目标不被删除", () => {
		const f = fixture(); writeExclusive(f.archived, "backup");
		expect(() => writeExclusive(f.archived, "bad")).toThrow();
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("恢复失败"); });
		expect(() => restoreSessionFile(f.file, "old", f.archived)).toThrow();
		expect(fs.readFileSync(f.archived, "utf8")).toBe("backup");
		expect(fs.readFileSync(f.file, "utf8")).toBe("original");
		replaceAtomic(f.file, "next"); expect(fs.readFileSync(f.file, "utf8")).toBe("next");
	});
});
