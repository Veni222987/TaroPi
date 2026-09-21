import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { generateSearchSummary } from "./summary.ts";
import type { QueryResultData } from "../content/storage.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-summary-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
});

const results: QueryResultData[] = [{ query: "q1", answer: "answer one", results: [{ title: "T", url: "https://a.com", snippet: "" }], error: null, provider: "exa" }];

describe("generateSearchSummary", () => {
	it("无可用模型时降级为确定性摘要", async () => {
		const ctx = { model: undefined, modelRegistry: { find: () => undefined } } as never;
		const generated = await generateSearchSummary(results, ctx, undefined);
		expect(generated.meta.fallbackUsed).toBe(true);
		expect(generated.summary).toContain("q1");
	});

	it("summaryModel 配置非法时降级并给出原因", async () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify({ summaryModel: "no-slash" }));
		clearWebSearchConfigCache();
		const ctx = { model: undefined, modelRegistry: { find: () => undefined } } as never;
		const generated = await generateSearchSummary(results, ctx, undefined);
		expect(generated.meta.fallbackUsed).toBe(true);
		expect(generated.meta.fallbackReason).toContain("summaryModel");
	});

	it("模型认证失败时降级为确定性摘要", async () => {
		const ctx = {
			model: { provider: "openai", id: "gpt", input: ["text"] },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) },
		} as never;
		const generated = await generateSearchSummary(results, ctx, undefined);
		expect(generated.meta.fallbackUsed).toBe(true);
	});

	it("查询失败时确定性摘要标注失败原因", async () => {
		const failed: QueryResultData[] = [{ query: "q1", answer: "", results: [], error: "boom" }];
		const ctx = { model: undefined, modelRegistry: { find: () => undefined } } as never;
		const generated = await generateSearchSummary(failed, ctx, undefined);
		expect(generated.summary).toContain("boom");
	});
});
