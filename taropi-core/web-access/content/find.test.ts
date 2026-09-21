import { describe, expect, it } from "vitest";
import { findContent } from "./find.ts";

describe("findContent", () => {
	const text = "The quick brown fox jumps over the lazy dog. ".repeat(3) + "A unique needle sits here for searching.";

	it("精确模式区分大小写", () => {
		const result = findContent(text, ["Fox"], "exact");
		expect(result.matchCount).toBe(0);
	});

	it("忽略大小写模式能命中", () => {
		const result = findContent(text, ["fox"], "case-insensitive");
		expect(result.matchCount).toBeGreaterThan(0);
		expect(result.text).toContain("fox");
	});

	it("无匹配时给出提示", () => {
		const result = findContent(text, ["zzz-not-present"], "case-insensitive");
		expect(result.matchCount).toBe(0);
		expect(result.text).toContain("no matches");
	});

	it("模糊模式容忍拼写差异", () => {
		const result = findContent(text, ["neeedle"], "fuzzy");
		expect(result.matchCount).toBeGreaterThan(0);
	});

	it("多个 query 分别统计命中数", () => {
		const result = findContent(text, ["fox", "needle"], "case-insensitive");
		expect(result.queryResults).toEqual([
			{ query: "fox", matchCount: expect.any(Number) },
			{ query: "needle", matchCount: expect.any(Number) },
		]);
	});

	it("空白 query 被过滤", () => {
		const result = findContent(text, ["  ", ""], "case-insensitive");
		expect(result.queryResults).toEqual([]);
	});
});
