import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { clearResults } from "../content/storage.ts";

vi.mock("../search/index.ts", () => ({
	normalizeProviderSelection: vi.fn((v: unknown) => v ?? "auto"),
	resolveRequestedProvider: vi.fn(() => "auto"),
	search: vi.fn(),
}));
vi.mock("../fetch/index.ts", () => ({ fetchAllContent: vi.fn() }));

import { fetchAllContent } from "../fetch/index.ts";
import { search } from "../search/index.ts";
import { createSourceCheckTool } from "./source-check.ts";

const tool = createSourceCheckTool();
let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-tool-sourcecheck-"));
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

describe("source_check 工具", () => {
	it("空 claim 时报错", async () => {
		const result = await tool.execute("c1", { claim: "   " }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ error: "Missing claim" });
	});

	it("成功时返回来源与证据 artifact", async () => {
		vi.mocked(search).mockResolvedValue({ answer: "supporting answer", results: [{ title: "T", url: "https://a.com", snippet: "s" }], provider: "exa" });
		const result = await tool.execute("c1", { claim: "the sky is blue" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ sourceCount: 1 });
		expect((result.content[0] as { text: string }).text).toContain("NOT auto-verified");
	});

	it("fetchContent 为 true 时附带抓取正文的证据", async () => {
		vi.mocked(search).mockResolvedValue({ answer: "", results: [{ title: "T", url: "https://a.com", snippet: "" }], provider: "exa" });
		vi.mocked(fetchAllContent).mockResolvedValue([{ url: "https://a.com", title: "T", content: "the sky is blue because of scattering", error: null }]);
		const result = await tool.execute("c1", { claim: "the sky is blue", fetchContent: true }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ passageCount: expect.any(Number) });
	});

	it("搜索失败时记录错误但继续返回 artifact", async () => {
		vi.mocked(search).mockRejectedValue(new Error("search failed"));
		const result = await tool.execute("c1", { claim: "claim" }, undefined, undefined, undefined as never);
		expect(result.details).toMatchObject({ sourceCount: 0 });
	});
});
