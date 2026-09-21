import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { clearResults } from "../content/storage.ts";

vi.mock("../fetch/index.ts", () => ({ fetchAllContent: vi.fn() }));

import { fetchAllContent } from "../fetch/index.ts";
import { createFetchContentTool } from "./fetch-content.ts";

const tool = createFetchContentTool();
let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-tool-fetch-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	clearResults();
	vi.mocked(fetchAllContent).mockReset();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
	clearResults();
});

describe("fetch_content 工具", () => {
	it("未提供 URL 时报错", async () => {
		const result = await tool.execute("c1", {}, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "No URL provided" });
	});

	it("mode=answer 但缺少 prompt 时报错", async () => {
		const result = await tool.execute("c1", { url: "https://a.com", mode: "answer" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "mode answer requires prompt" });
	});

	it("mode=raw 与 auth 组合时报错", async () => {
		const result = await tool.execute("c1", { url: "https://a.com", mode: "raw", auth: true }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "Incompatible raw mode options" });
	});

	it("单个 URL 抓取成功返回正文与 responseId", async () => {
		vi.mocked(fetchAllContent).mockResolvedValue([{ url: "https://a.com", title: "Title A", content: "body content", error: null }]);
		const result = await tool.execute("c1", { url: "https://a.com" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ urlCount: 1, successful: 1, title: "Title A" });
		expect((result.content.at(-1) as { text: string }).text).toContain("body content");
	});

	it("单个 URL 抓取失败时返回错误详情", async () => {
		vi.mocked(fetchAllContent).mockResolvedValue([{ url: "https://a.com", title: "", content: "", error: "HTTP 404" }]);
		const result = await tool.execute("c1", { url: "https://a.com" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ successful: 0, error: "HTTP 404" });
	});

	it("多个 URL 时汇总为列表", async () => {
		vi.mocked(fetchAllContent).mockResolvedValue([
			{ url: "https://a.com", title: "A", content: "1234", error: null },
			{ url: "https://b.com", title: "", content: "", error: "timeout" },
		]);
		const result = await tool.execute("c1", { urls: ["https://a.com", "https://b.com"] }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ urlCount: 2, successful: 1 });
	});

	it("超过内联字符上限时截断并提示分页", async () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify({ maxInlineContentChars: 10 }));
		clearWebSearchConfigCache();
		vi.mocked(fetchAllContent).mockResolvedValue([{ url: "https://a.com", title: "A", content: "0123456789ABCDEF", error: null }]);
		const result = await tool.execute("c1", { url: "https://a.com" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ truncated: true });
	});
});
