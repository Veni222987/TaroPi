import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { archiveFilePath, archiveLabel, archiveSessionFile, renderArchivedSession, renderEmptySession, replaceAtomic, restoreSessionFile } from "./file.ts";

// registerArchive 注册原路径清空、旧内容另存可恢复的 /archive 命令。
export default function registerArchive(pi: ExtensionAPI): void {
	let running: AbortController | undefined;
	pi.on("session_shutdown", () => running?.abort());
	pi.on("input", (event) => { if (event.source !== "extension") running?.abort(); });
	pi.registerCommand("archive", {
		description: "归档旧对话为可恢复会话，保留当前 id、路径和名称并清空上下文",
		handler: async (_args, ctx) => {
			if (running) { ctx.ui.notify("正在归档，请等待或取消", "warning"); return; }
			const controller = new AbortController();
			running = controller;
			try { await archive(ctx, controller.signal); }
			finally { if (running === controller) running = undefined; }
		},
	});
}

async function archive(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
	let prepared: { file: string; archivedPath: string; original: string };
	try {
		const file = ctx.sessionManager.getSessionFile();
		if (!file || !fs.existsSync(file)) { ctx.ui.notify("当前会话未持久化或尚未落盘，无可归档内容", "info"); return; }
		if (ctx.hasUI && !await ctx.ui.confirm("归档并清空当前会话？", `旧内容另存为同目录的可恢复会话；当前 id、路径和名称不变，活动 plan 将终止。\n${file}`)) return;
		if (signal.aborted) return;
		ctx.abort();
		await ctx.waitForIdle();
		if (signal.aborted) return;
		const manager = ctx.sessionManager;
		const name = manager.getSessionName();
		const label = archiveLabel(name, firstVisibleText(manager.getBranch()));
		const header = manager.getHeader();
		if (!header) throw new Error("会话文件头缺失");
		const original = fs.readFileSync(file, "utf8");
		const date = new Date();
		const archivedPath = archiveFilePath(path.dirname(file), label, date);
		const archived = renderArchivedSession(original, randomUUID(), label, manager.getLeafId());
		const empty = renderEmptySession({ id: manager.getSessionId(), cwd: header.cwd, parentSession: header.parentSession }, name, date);
		archiveSessionFile(file, archivedPath, archived, empty);
		prepared = { file, archivedPath, original };
	} catch (error) {
		if (signal.aborted) return;
		ctx.ui.notify(`归档未完成：${String(error)}`, "error");
		return;
	}
	const { file, archivedPath, original } = prepared;
	try {
		const result = await ctx.switchSession(file, {
			withSession: async (fresh) => {
				try {
					const content = [fresh.sessionManager.getHeader(), ...fresh.sessionManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
					if (fs.readFileSync(file, "utf8") !== content) {
						replaceAtomic(file, content);
						fresh.ui.notify("关闭旧会话时存在额外写入，已按新会话内存重写文件", "warning");
					}
					fresh.ui.notify(`已归档：${archivedPath}；可通过 /resume 搜索和恢复`, "info");
				} catch (error) {
					fresh.ui.notify(`会话已重载，但文件校验失败；归档保留在 ${archivedPath}：${String(error)}`, "error");
				}
			},
		});
		if (result.cancelled) {
			restoreSessionFile(file, original, archivedPath);
			ctx.ui.notify("会话切换被取消，已恢复原文件", "warning");
		}
	} catch (error) {
		let active = false;
		try { ctx.isIdle(); active = true; } catch { /* runtime 已替换或失效，不能再使用旧 ctx。 */ }
		try {
			if (active) restoreSessionFile(file, original, archivedPath);
			else replaceAtomic(file, original);
		} catch (rollbackError) {
			throw new Error(`归档切换及回滚失败；保留归档 ${archivedPath}，请手动恢复：${String(error)}；${String(rollbackError)}`);
		}
		if (!active) throw new Error(`归档切换失败，原文件已恢复，归档保留在 ${archivedPath}；runtime 已失效，请重新启动：${String(error)}`);
		ctx.ui.notify(`归档切换失败，已恢复原文件：${String(error)}`, "error");
	}
}

function firstVisibleText(entries: readonly SessionEntry[]): string {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
		if (text.trim()) return text;
	}
	return "";
}
