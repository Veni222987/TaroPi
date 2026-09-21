import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { openaiProvider } from "./openai.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-openai-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.OPENAI_API_KEY;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
	vi.restoreAllMocks();
});

function sseResponse(): Response {
	const body = [
		'data: {"type":"response.output_item.done","item":{"type":"web_search_call"}}',
		'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Answer text","annotations":[{"type":"url_citation","url":"https://source.example.com","title":"Source"}]}]}}',
		"data: [DONE]",
		"",
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("openaiProvider", () => {
	it("无任何凭据时不可用", async () => {
		expect(await openaiProvider.isAvailable()).toBe(false);
	});

	it("独立 API Key 时可用并成功搜索", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		expect(await openaiProvider.isAvailable()).toBe(true);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());
		const result = await openaiProvider.search("q", {});
		expect(result.answer).toBe("Answer text");
		expect(result.results[0].url).toBe("https://source.example.com/");
	});

	it("无凭据时搜索报错并给出登录/配置提示", async () => {
		await expect(openaiProvider.search("q", {})).rejects.toThrow(/OpenAI web search unavailable/);
	});

	it("openaiResponsesUrl 非法时报错", () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify({ openaiResponsesUrl: "not-a-url" }));
		clearWebSearchConfigCache();
		process.env.OPENAI_API_KEY = "sk-test";
		return expect(openaiProvider.search("q", {})).rejects.toThrow();
	});

	it("响应中缺少 web_search_call 时报错", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const body = 'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"no search"}]}}\ndata: [DONE]\n';
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
		await expect(openaiProvider.search("q", {})).rejects.toThrow(/no web_search_call/);
	});

	it("Pi 托管认证可用时优先于独立 Key", async () => {
		process.env.OPENAI_API_KEY = "sk-standalone";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());
		const ctx = {
			model: undefined,
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.1" }],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token", headers: {} }),
			},
		} as never;
		const result = await openaiProvider.search("q", {}, ctx);
		expect(result.answer).toBe("Answer text");
	});
});
