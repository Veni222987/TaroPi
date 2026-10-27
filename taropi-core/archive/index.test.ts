import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as files from "./file.ts";
import registerArchive from "./index.ts";

type ReplacedSessionContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>>[0];
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(persist = true, conversation = true) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "archive-command-")); directories.push(cwd);
	const manager = persist ? SessionManager.create(cwd, cwd) : SessionManager.inMemory(cwd);
	if (conversation) manager.appendMessage({ role: "user", content: "首条需求", timestamp: 1 });
	manager.appendSessionInfo("原会话名称");
	const notify = vi.fn(), confirm = vi.fn(async () => true);
	const calls: string[] = [];
	const ctx = { cwd, hasUI: true, sessionManager: manager, ui: { notify, confirm },
		abort: vi.fn(() => { calls.push("abort"); }), waitForIdle: vi.fn(async () => { calls.push("idle"); }), isIdle: vi.fn(() => true),
		switchSession: vi.fn<ExtensionCommandContext["switchSession"]>(async (file, options) => {
			calls.push("switch");
			await options?.withSession?.({ sessionManager: SessionManager.open(file), ui: { notify } } as unknown as ReplacedSessionContext);
			return { cancelled: false };
		}),
	} as unknown as ExtensionCommandContext;
	let handler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
	const api = { registerCommand: vi.fn((_name, command) => { handler = command.handler; }), on: vi.fn() };
	registerArchive(api as unknown as ExtensionAPI);
	return { ctx, manager, notify, confirm, calls, api, cwd, run: () => handler!("", ctx), file: manager.getSessionFile() };
}

describe("/archive 命令", () => {
	it.each([[false, true], [true, false]])("不归档未持久化或未落盘的会话 %s/%s", async (persist, conversation) => {
		const f = fixture(persist, conversation); await f.run();
		expect(f.ctx.abort).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("无可归档内容"), "info");
	});
	it.each([["原名称", "原名称-archived"], ["", "首条需求-archived"], ["  ", "首条需求-archived"]])("会话名 %j 按规则归档为 %s", async (name, expected) => {
		const f = fixture(); f.manager.appendSessionInfo(name); await f.run();
		const archived = (await SessionManager.list(f.cwd, f.cwd)).find((item) => item.id !== f.manager.getSessionId())!;
		expect(archived.name).toBe(expected);
		expect(path.basename(archived.path)).toMatch(new RegExp(`^${expected}-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}\\.jsonl$`));
	});
	it("未命名会话取首条用户文本前 30 字，没有文本时用 session", async () => {
		const f = fixture(true, false);
		f.manager.appendMessage({ role: "user", content: `  ${"鹅".repeat(40)} 继续`, timestamp: 1 });
		f.manager.appendSessionInfo(""); await f.run();
		const archived = (await SessionManager.list(f.cwd, f.cwd)).find((item) => item.id !== f.manager.getSessionId())!;
		expect(archived.name).toBe(`${"鹅".repeat(30)}-archived`);
		const empty = fixture(true, false); empty.manager.appendMessage({ role: "assistant", content: "没有用户文本", timestamp: 1 }); empty.manager.appendSessionInfo(""); await empty.run();
		const fallback = (await SessionManager.list(empty.cwd, empty.cwd)).find((item) => item.id !== empty.manager.getSessionId())!;
		expect(fallback.name).toBe("session-archived");
	});
	it("UI 取消不改文件", async () => {
		const f = fixture(); const before = fs.readFileSync(f.file!, "utf8"); f.confirm.mockResolvedValueOnce(false);
		await f.run(); expect(f.ctx.abort).not.toHaveBeenCalled();
		expect(fs.readFileSync(f.file!, "utf8")).toBe(before); expect(f.ctx.switchSession).not.toHaveBeenCalled();
		expect(fs.readdirSync(f.cwd)).toEqual([path.basename(f.file!)]);
	});
	it("按 abort → idle → 归档 → switch 顺序执行且成功后只用新 ctx", async () => {
		const f = fixture();
		const original = files.archiveSessionFile;
		vi.spyOn(files, "archiveSessionFile").mockImplementation((...args) => { f.calls.push("archive"); original(...args); });
		await f.run(); expect(f.calls).toEqual(["abort", "idle", "archive", "switch"]);
		expect(f.ctx.isIdle).not.toHaveBeenCalled();
		const fresh = SessionManager.open(f.file!);
		expect(fresh.getSessionId()).toBe(f.manager.getSessionId()); expect(fresh.getSessionName()).toBe("原会话名称");
		expect(fresh.buildSessionContext().messages).toEqual([]);
		expect(fs.readdirSync(f.cwd).filter((file) => file.includes("archived"))).toHaveLength(1);
	});
	it.each(["cancel", "throw"])("切换 %s 回滚原内容并清理归档", async (mode) => {
		const f = fixture(); const before = fs.readFileSync(f.file!, "utf8");
		vi.mocked(f.ctx.switchSession).mockImplementationOnce(async () => {
			if (mode === "throw") throw new Error("无法打开");
			return { cancelled: true };
		});
		await f.run(); expect(fs.readFileSync(f.file!, "utf8")).toBe(before);
		expect(fs.readdirSync(f.cwd)).toEqual([path.basename(f.file!)]);
	});
	it("关闭阶段的写入按新内存重写，无 UI 直接执行", async () => {
		const f = fixture(); f.ctx.hasUI = false;
		vi.mocked(f.ctx.switchSession).mockImplementationOnce(async (file, options) => {
			const fresh = SessionManager.open(file); fs.appendFileSync(file, 'shutdown extra\n');
			await options?.withSession?.({ sessionManager: fresh, ui: { notify: f.notify } } as unknown as ReplacedSessionContext);
			return { cancelled: false };
		});
		await f.run(); expect(f.confirm).not.toHaveBeenCalled();
		expect(fs.readFileSync(f.file!, "utf8")).not.toContain("shutdown extra");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("额外写入"), "warning");
	});
	it("runtime 失效或恢复失败时保留备份，不误报完整回滚", async () => {
		const f = fixture(); const before = fs.readFileSync(f.file!, "utf8");
		vi.mocked(f.ctx.switchSession).mockRejectedValueOnce(new Error("createRuntime 失败"));
		vi.mocked(f.ctx.isIdle).mockImplementationOnce(() => { throw new Error("stale"); });
		await expect(f.run()).rejects.toThrow("请重新启动");
		expect(fs.readFileSync(f.file!, "utf8")).toBe(before);
		expect(fs.readdirSync(f.cwd).filter((file) => file.includes("archived"))).toHaveLength(1);
	});
	it("回滚写入失败保留归档并报告位置", async () => {
		const f = fixture(); vi.mocked(f.ctx.switchSession).mockRejectedValueOnce(new Error("switch 失败"));
		vi.spyOn(files, "restoreSessionFile").mockImplementationOnce(() => { throw new Error("磁盘故障"); });
		await expect(f.run()).rejects.toThrow("回滚失败");
		expect(fs.readdirSync(f.cwd).filter((file) => file.includes("archived"))).toHaveLength(1);
	});
	it("同分钟同名拒绝归档，当前及归档都不覆盖", async () => {
		const f = fixture(); const before = fs.readFileSync(f.file!, "utf8");
		vi.spyOn(files, "archiveFilePath").mockReturnValueOnce(path.join(f.cwd, "collision.jsonl"));
		fs.writeFileSync(path.join(f.cwd, "collision.jsonl"), "another session");
		await f.run(); expect(fs.readFileSync(f.file!, "utf8")).toBe(before);
		expect(fs.readFileSync(path.join(f.cwd, "collision.jsonl"), "utf8")).toBe("another session");
		expect(f.ctx.switchSession).not.toHaveBeenCalled();
	});
	it("文件校验失败保留归档，不回滚已替换的 runtime", async () => {
		const f = fixture();
		vi.mocked(f.ctx.switchSession).mockImplementationOnce(async (file, options) => {
			const fresh = SessionManager.open(file); fs.appendFileSync(file, "extra\n");
			vi.spyOn(files, "replaceAtomic").mockImplementationOnce(() => { throw new Error("校验重写失败"); });
			await options?.withSession?.({ sessionManager: fresh, ui: { notify: f.notify } } as unknown as ReplacedSessionContext);
			return { cancelled: false };
		});
		await f.run(); expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("文件校验失败"), "error");
		expect(fs.readdirSync(f.cwd).filter((file) => file.includes("archived"))).toHaveLength(1);
	});
	it("重复入口不并发归档，shutdown 取消等待中的确认", async () => {
		const f = fixture(); let finish: ((value: boolean) => void) | undefined;
		f.confirm.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		const pending = f.run();
		while (!finish) await Promise.resolve();
		await f.run(); expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("正在归档"), "warning");
		const shutdown = f.api.on.mock.calls.find(([event]) => event === "session_shutdown")![1]; shutdown();
		finish(false); await pending; expect(f.ctx.switchSession).not.toHaveBeenCalled();
	});
});
