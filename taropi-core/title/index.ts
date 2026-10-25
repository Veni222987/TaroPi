import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { safeFileNamePart } from "./file-name.ts";

const TITLE_TIMEOUT_MS = 15_000;
const CONTEXT_CHARACTER_LIMIT = 8_000;
const SUMMARY_CHARACTER_LIMIT = 2_000;

export interface TitleOptions {
	prompt: string;
	dialogTitle: string;
	cancelLabel?: string;
	fallback?: string;
	defaultTitle?: string;
	taskLabel?: string;
	resolveModel?: () => ExtensionContext["model"];
}

// generateTitle 用独立辅助请求概括短标题，失败时仅使用显式回退值，未配置或取消则不生成标题。
export async function generateTitle(task: string, ctx: ExtensionContext, options: TitleOptions, signal: AbortSignal): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const cancellation = new AbortController();
	const dialog = new AbortController();
	const external = AbortSignal.any([signal, cancellation.signal, ...(ctx.signal ? [ctx.signal] : [])]);
	const request = requestTitle(task, ctx, options, external);
	try {
		if (!ctx.hasUI) return await request;
		const cancelled = ctx.ui.select(options.dialogTitle, [options.cancelLabel ?? "取消"], { signal: dialog.signal })
			.then(() => { if (!dialog.signal.aborted) cancellation.abort(); return undefined; }, (error: unknown) => {
				if (dialog.signal.aborted) return undefined;
				cancellation.abort();
				throw error;
			});
		return await Promise.race([request, cancelled]);
	} finally {
		dialog.abort();
		cancellation.abort();
	}
}

// titleInput 提取当前分支最近的可见文本与最新压缩摘要，仅用于独立标题请求。
export function titleInput(task: string, entries: readonly SessionEntry[], taskLabel = "当前任务"): string {
	const compactIndex = entries.findLastIndex((entry) => entry.type === "compaction");
	const compact = entries[compactIndex];
	const summary = compact?.type === "compaction" ? Array.from(`压缩摘要：\n${compact.summary}`).slice(0, SUMMARY_CHARACTER_LIMIT).join("") : "";
	let remaining = CONTEXT_CHARACTER_LIMIT - Array.from(summary).length - (summary ? 2 : 0);
	const recent: string[] = [];
	for (let index = entries.length - 1; index > compactIndex && remaining > 0; index--) {
		const entry = entries[index]!;
		let text = "";
		if (entry.type === "branch_summary") text = `分支摘要：\n${entry.summary}`;
		else if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			const content = entry.message.content;
			const visible = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (visible.trim()) text = `${entry.message.role === "user" ? "用户" : "助手"}：\n${visible}`;
		}
		if (!text.trim()) continue;
		const characters = Array.from(text);
		const kept = characters.slice(-remaining).join("");
		recent.unshift(kept);
		remaining -= Array.from(kept).length + 2;
	}
	const context = [summary, ...recent].filter(Boolean).join("\n\n");
	return context ? `最近会话（仅供命名参考）：\n${context}\n\n${taskLabel}：\n${task}` : task;
}

async function requestTitle(task: string, ctx: ExtensionContext, options: TitleOptions, signal: AbortSignal): Promise<string | undefined> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new Error("标题概括超时")), TITLE_TIMEOUT_MS);
	const combined = AbortSignal.any([signal, timeout.signal]);
	let onAbort: (() => void) | undefined;
	try {
		if (signal.aborted) return undefined;
		let model = ctx.model;
		try { model = options.resolveModel?.() ?? model; } catch { /* 解析失败时沿用当前模型。 */ }
		if (!model) throw new Error("没有可用模型");
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(combined.reason);
			if (combined.aborted) onAbort(); else combined.addEventListener("abort", onAbort, { once: true });
		});
		let input = task;
		try { input = titleInput(task, ctx.sessionManager.getBranch(), options.taskLabel); }
		catch {
			if (options.fallback === undefined) throw new Error("标题上下文读取失败");
			ctx.ui.notify("标题上下文读取失败，仅使用当前任务概括", "warning");
		}
		if (options.fallback === undefined && input === task) throw new Error("会话没有可概括的文本");
		const response = await Promise.race([ctx.modelRegistry.streamSimple(model, {
			systemPrompt: options.prompt,
			messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
		}, { signal: combined, maxTokens: 128, cacheRetention: "none" }).result(), aborted]);
		if (signal.aborted) return undefined;
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "标题概括请求失败");
		const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
		const title = safeFileNamePart(text, "");
		if (!title) throw new Error("模型返回空标题或非法标题");
		return title;
	} catch (error) {
		if (signal.aborted) return undefined;
		const message = error instanceof Error ? error.message : String(error);
		if (options.fallback === undefined) {
			ctx.ui.notify(`短标题概括失败，未生成标题：${message}`, "warning");
			return undefined;
		}
		ctx.ui.notify(`短标题概括失败，使用回退标题：${message}`, "warning");
		return safeFileNamePart(options.fallback, options.defaultTitle ?? "session");
	} finally {
		clearTimeout(timer);
		if (onAbort) combined.removeEventListener("abort", onAbort);
	}
}
