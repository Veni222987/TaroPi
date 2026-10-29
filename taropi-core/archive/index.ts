import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { archiveFilePath, archiveLabel, archiveSessionFile, archiveSessionName, customArchiveLabel, renderArchivedSession, renderEmptySession, replaceAtomic, restoreSessionFile } from "./file.ts";

// registerArchive 注册原路径清空、旧内容另存可恢复的 /archive 命令。
export default function registerArchive(pi: ExtensionAPI): void {
	let running: AbortController | undefined;
	pi.on("session_shutdown", () => running?.abort());
	pi.on("input", (event) => { if (event.source !== "extension") running?.abort(); });
	pi.registerCommand("archive", {
		description: "归档旧对话并清空上下文，保留当前 id、路径和名称；/archive [自定义标题]，省略标题时用会话名或首条用户消息",
		handler: async (args, ctx) => {
			if (running) { ctx.ui.notify("正在归档，请等待或取消", "warning"); return; }
			const controller = new AbortController();
			running = controller;
			try { await archive(ctx, controller.signal, args); }
			finally { if (running === controller) running = undefined; }
		},
	});
}

async function archive(ctx: ExtensionCommandContext, signal: AbortSignal, args: string): Promise<void> {
	let prepared: { file: string; archivedPath: string; original: string };
	try {
		const file = ctx.sessionManager.getSessionFile();
		if (!file || !fs.existsSync(file)) { ctx.ui.notify("当前会话未持久化或尚未落盘，无可归档内容", "info"); return; }
		const customTitle = args.trim();
		const customLabel = customTitle ? customArchiveLabel(customTitle) : undefined;
		if (customTitle && !customLabel) { ctx.ui.notify("归档已取消：自定义标题无效，请换一个标题", "warning"); return; }
		const manager = ctx.sessionManager;
		const label = customLabel ?? archiveLabel(manager.getSessionName(), firstVisibleText(manager.getBranch()));
		const date = new Date();
		const archivedPath = archiveFilePath(path.dirname(file), label, date);
		if (ctx.hasUI && !await ctx.ui.confirm("归档并清空当前会话？", `旧内容另存为同目录的可恢复会话；当前 id、路径和名称不变，活动 plan 将终止。\n归档路径：${archivedPath}`)) return;
		if (signal.aborted) return;
		ctx.abort();
		await ctx.waitForIdle();
		if (signal.aborted) return;
		const name = manager.getSessionName();
		const header = manager.getHeader();
		if (!header) throw new Error("会话文件头缺失");
		const original = fs.readFileSync(file, "utf8");
		const archived = renderArchivedSession(original, randomUUID(), archiveSessionName(archivedPath), manager.getLeafId());
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
