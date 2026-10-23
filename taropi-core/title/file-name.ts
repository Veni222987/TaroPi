// safeFileNamePart 清理 Markdown 标记和文件名非法字符，最多保留 20 个 Unicode 字符。
export function safeFileNamePart(value: string, fallback = "plan"): string {
	const firstLine = value.split(/\r\n?|\n/).find((line) => line.trim()) ?? "";
	const normalized = firstLine.trim().replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "").replace(/[\\/:：*?"<>|\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, "-").replace(/-+/g, "-");
	return Array.from(normalized.replace(/^[.\s-]+|[.\s-]+$/g, "")).slice(0, 20).join("").replace(/[.\s-]+$/g, "") || fallback;
}

// localMinute 使用本机时区生成分钟时间戳。
export function localMinute(date: Date): string {
	if (!Number.isFinite(date.getTime())) throw new Error("时间无效");
	const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
	return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
}
