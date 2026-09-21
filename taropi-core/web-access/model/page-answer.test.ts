import { describe, expect, it } from "vitest";
import { answerFromPage } from "./page-answer.ts";

describe("answerFromPage", () => {
	it("无当前模型且无覆盖时报错", async () => {
		const ctx = { model: undefined, modelRegistry: { find: () => undefined } } as never;
		await expect(answerFromPage({ question: "q", pageText: "text", sourceUrl: "https://a.com" }, ctx)).rejects.toThrow(/No current model available/);
	});

	it("覆盖模型不存在时报错", async () => {
		const ctx = { model: undefined, modelRegistry: { find: () => undefined } } as never;
		await expect(answerFromPage({ question: "q", pageText: "text", sourceUrl: "https://a.com", model: "openai/gpt-5" }, ctx)).rejects.toThrow(/Answer model not found/);
	});

	it("模型不支持文本输入时报错", async () => {
		const ctx = { model: { provider: "x", id: "y", input: ["image"] }, modelRegistry: { find: () => undefined } } as never;
		await expect(answerFromPage({ question: "q", pageText: "text", sourceUrl: "https://a.com" }, ctx)).rejects.toThrow(/does not support text input/);
	});

	it("答案模型认证失败时报错", async () => {
		const ctx = {
			model: { provider: "x", id: "y", input: ["text"] },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) },
		} as never;
		await expect(answerFromPage({ question: "q", pageText: "text", sourceUrl: "https://a.com" }, ctx)).rejects.toThrow(/No API key available/);
	});

	it("answerModel 格式非法时报错", async () => {
		const ctx = { model: undefined, modelRegistry: { find: () => undefined } } as never;
		await expect(answerFromPage({ question: "q", pageText: "text", sourceUrl: "https://a.com", model: "invalid" }, ctx)).rejects.toThrow(/Invalid answerModel/);
	});
});
