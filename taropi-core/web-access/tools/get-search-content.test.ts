import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearResults, generateId, storeFetchResult, storeResult } from "../content/storage.ts";
import { storeResearchArtifact, buildResearchArtifact } from "../research/source-check.ts";
import { createGetSearchContentTool } from "./get-search-content.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearWebSearchConfigCache } from "../config.ts";

const tool = createGetSearchContentTool();
let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-tool-getcontent-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	clearResults();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
	clearResults();
});

describe("get_search_content 工具", () => {
	it("未知 responseId 返回错误", async () => {
		const result = await tool.execute("c1", { responseId: "missing" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "Not found" });
	});

	it("按 queryIndex 检索 search 类型结果", async () => {
		const id = generateId();
		storeResult(id, { id, type: "search", timestamp: Date.now(), queries: [{ query: "q1", answer: "a1", results: [], error: null, provider: "exa" }] });
		const result = await tool.execute("c1", { responseId: id, queryIndex: 0 }, undefined, undefined, undefined as never);
		expect((result.content[0] as { text: string }).text).toContain("a1");
	});

	it("query 不存在时列出可用查询", async () => {
		const id = generateId();
		storeResult(id, { id, type: "search", timestamp: Date.now(), queries: [{ query: "q1", answer: "a1", results: [], error: null }] });
		const result = await tool.execute("c1", { responseId: id, query: "not-exist" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "Query not found" });
	});

	it("按 urlIndex 检索 fetch 类型结果并支持分页", async () => {
		const id = generateId();
		const longContent = "x".repeat(100);
		storeFetchResult(id, { id, type: "fetch", timestamp: Date.now(), urls: [{ url: "https://a.com", title: "A", content: longContent, error: null }] });
		const result = await tool.execute("c1", { responseId: id, urlIndex: 0, offset: 0, limit: 10 }, undefined, undefined, undefined as never);
		expect((result.details as { returnedChars: number }).returnedChars).toBe(10);
		expect((result.details as { truncated: boolean }).truncated).toBe(true);
	});

	it("offset 超出范围时报错", async () => {
		const id = generateId();
		storeFetchResult(id, { id, type: "fetch", timestamp: Date.now(), urls: [{ url: "https://a.com", title: "A", content: "short", error: null }] });
		const result = await tool.execute("c1", { responseId: id, urlIndex: 0, offset: 999 }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "Offset out of range" });
	});

	it("findText 在 fetch 内容中定位片段", async () => {
		const id = generateId();
		storeFetchResult(id, { id, type: "fetch", timestamp: Date.now(), urls: [{ url: "https://a.com", title: "A", content: "hello unique-marker world", error: null }] });
		const result = await tool.execute("c1", { responseId: id, urlIndex: 0, findText: "unique-marker" }, undefined, undefined, undefined as never);
		expect((result.content[0] as { text: string }).text).toContain("unique-marker");
	});

	it("research 类型返回 artifact JSON 分片", async () => {
		const artifact = buildResearchArtifact({ query: "claim", results: [{ title: "T", url: "https://a.com", snippet: "s" }] });
		storeResearchArtifact(artifact);
		const result = await tool.execute("c1", { responseId: artifact.id, offset: 0, limit: 20 }, undefined, undefined, undefined as never);
		expect((result.details as { type: string }).type).toBe("research");
	});
});
