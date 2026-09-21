import { describe, expect, it } from "vitest";
import { isPDF } from "./pdf.ts";

describe("isPDF", () => {
	it("按 Content-Type 判断", () => {
		expect(isPDF("https://a.com/file", "application/pdf")).toBe(true);
	});

	it("按 URL 扩展名判断", () => {
		expect(isPDF("https://a.com/doc.pdf")).toBe(true);
		expect(isPDF("https://a.com/doc.txt")).toBe(false);
	});

	it("非法 URL 返回 false", () => {
		expect(isPDF("not a url")).toBe(false);
	});
});
