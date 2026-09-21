import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { clearResults, getResult } from "../content/storage.ts";

vi.mock("../search/index.ts", () => ({
	normalizeProviderSelection: vi.fn((v: unknown) => v ?? "auto"),
	resolveRequestedProvider: vi.fn(() => "auto"),
	search: vi.fn(),
}));
vi.mock("../fetch/index.ts", () => ({ fetchAllContent: vi.fn() }));

import { fetchAllContent } from "../fetch/index.ts";
import { search } from "../search/index.ts";
import { createWebSearchTool } from "./web-search.ts";

let tempDir: string;
const tool = createWebSearchTool();

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-tool-search-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	clearResults();
	vi.mocked(search).mockReset();
	vi.mocked(fetchAllContent).mockReset();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
	clearResults();
});

describe("web_search 工具", () => {
	it("缺少 query/queries 时返回错误", async () => {
		const result = await tool.execute("call1", {}, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "No query provided" });
	});

	it("单个 query 成功时汇总来源与 responseId", async () => {
		vi.mocked(search).mockResolvedValue({ answer: "answer text", results: [{ title: "T", url: "https://x.com", snippet: "s" }], provider: "exa" });
		const result = await tool.execute("call1", { query: "hello" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ successfulQueries: 1, totalResults: 1 });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("answer text");
		const responseId = (result.details as { responseId: string }).responseId;
		expect(getResult(responseId)?.type).toBe("search");
	});

	it("单个查询失败时记录错误但不抛出", async () => {
		vi.mocked(search).mockRejectedValue(new Error("provider down"));
		const result = await tool.execute("call1", { query: "hello" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ successfulQueries: 0 });
		expect((result.content[0] as { text: string }).text).toContain("provider down");
	});

	it("非法 provider 参数返回错误而不是抛出异常", async () => {
		const { normalizeProviderSelection } = await import("../search/index.ts");
		vi.mocked(normalizeProviderSelection).mockImplementationOnce(() => {
			throw new Error("provider must be one of: brave, exa, openai");
		});
		const result = await tool.execute("call1", { query: "hello", provider: "bing" as never }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: expect.stringContaining("provider must be") });
	});
});
