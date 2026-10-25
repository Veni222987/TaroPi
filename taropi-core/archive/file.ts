import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionInfoEntry } from "@earendil-works/pi-coding-agent";
import { localMinute, safeFileNamePart } from "../title/file-name.ts";

// archiveFilePath 生成同目录可检索的归档路径，同分钟同名由排他写入拒绝。
export function archiveFilePath(directory: string, title: string, date: Date, name?: string): string {
	const prefix = name?.trim() ? `${safeFileNamePart(name, "session")}-` : "";
	return path.resolve(directory, `${prefix}${safeFileNamePart(title, "session")}-archived-${localMinute(date)}.jsonl`);
}

// archiveSessionName 拼接原会话名与活动概括，未命名会话仅显示活动概括和归档标记。
export function archiveSessionName(title: string, name?: string): string {
	const prefix = name?.trim() ? `${name.trim()}-` : "";
	return `${prefix}${safeFileNamePart(title, "session")}-archived`;
}

// renderArchivedSession 只更换会话身份并追加名称，原条目及其分支关系保持不变。
export function renderArchivedSession(content: string, newId: string, title: string, leafId?: string | null, name?: string): string {
	const separator = content.indexOf("\n");
	const firstLine = separator < 0 ? content : content.slice(0, separator);
	const rest = separator < 0 ? "" : content.slice(separator + 1);
	const header: unknown = JSON.parse(firstLine);
	if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session") throw new Error("会话文件头无效");
	let lastId: string | null = null;
	for (const line of rest.split("\n")) {
		if (!line.trim()) continue;
		const entry: unknown = JSON.parse(line);
		if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") throw new Error("会话条目无效");
		lastId = entry.id;
	}
	const body = rest && !rest.endsWith("\n") ? `${rest}\n` : rest;
	return `${JSON.stringify({ ...header, id: newId })}\n${body}${JSON.stringify(sessionInfo(archiveSessionName(title, name), leafId === undefined ? lastId : leafId))}\n`;
}

// renderEmptySession 保留基本信息，重建无消息的当前会话。
export function renderEmptySession(header: Pick<SessionHeader, "id" | "cwd" | "parentSession">, name?: string, date = new Date()): string {
	const next: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, ...header, timestamp: date.toISOString() };
	return `${JSON.stringify(next)}\n${name ? `${JSON.stringify(sessionInfo(name, null))}\n` : ""}`;
}

// writeExclusive 排他写入私有文件，写入失败仅清理本次创建的文件。
export function writeExclusive(file: string, content: string): void {
	const descriptor = fs.openSync(file, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, content, "utf8");
	} catch (error) {
		fs.unlinkSync(file);
		throw error;
	} finally {
		fs.closeSync(descriptor);
	}
}

// replaceAtomic 在同目录原子替换文件，失败保留原文件。
export function replaceAtomic(file: string, content: string): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeExclusive(temporary, content);
	try {
		fs.renameSync(temporary, file);
	} finally {
		if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
	}
}

// archiveSessionFile 先排他保存旧内容，再替换当前文件，替换失败清理本次归档。
export function archiveSessionFile(file: string, archivedPath: string, archivedContent: string, emptyContent: string): void {
	writeExclusive(archivedPath, archivedContent);
	try {
		replaceAtomic(file, emptyContent);
	} catch (error) {
		fs.unlinkSync(archivedPath);
		throw error;
	}
}

// restoreSessionFile 先恢复原文件，成功后才能移除本次归档。
export function restoreSessionFile(file: string, originalContent: string, archivedPath: string): void {
	replaceAtomic(file, originalContent);
	fs.unlinkSync(archivedPath);
}

function sessionInfo(name: string, parentId: string | null): SessionInfoEntry {
	return { type: "session_info", id: randomUUID(), parentId, timestamp: new Date().toISOString(), name };
}
