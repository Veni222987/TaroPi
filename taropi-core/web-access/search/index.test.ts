import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";

vi.mock("../searchimpl/index.ts", () => {
	const braveProvider = { id: "brave", label: "Brave", isAvailable: vi.fn(), search: vi.fn() };
	const exaProvider = { id: "exa", label: "Exa", isAvailable: vi.fn(), search: vi.fn() };
	const openaiProvider = { id: "openai", label: "OpenAI", isAvailable: vi.fn(), search: vi.fn() };
	const providers = { brave: braveProvider, exa: exaProvider, openai: openaiProvider };
	return {
		getSearchProvider: (id: string) => (providers as Record<string, unknown>)[id],
		getAllSearchProviders: () => Object.values(providers),
		SEARCH_PROVIDER_IDS: ["brave", "exa", "openai"],
		hasExaApiKey: vi.fn(),
		__providers: providers,
	};
});

import * as searchimpl from "../searchimpl/index.ts";
import { autoSearchOrder, normalizeProviderSelection, resolveRequestedProvider, search } from "./index.ts";

const providers = (searchimpl as unknown as { __providers: Record<string, { search: ReturnType<typeof vi.fn> }> }).__providers;

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-search-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	for (const provider of Object.values(providers)) provider.search.mockReset();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
});

describe("normalizeProviderSelection", () => {
	it("空值和 auto 归一化为 auto", () => {
		expect(normalizeProviderSelection(undefined)).toBe("auto");
		expect(normalizeProviderSelection("auto")).toBe("auto");
	});

	it("接受单个合法 provider（忽略大小写）", () => {
		expect(normalizeProviderSelection("Brave")).toBe("brave");
	});

	it("拒绝未知 provider", () => {
		expect(() => normalizeProviderSelection("bing")).toThrow(/must be "auto"/);
	});

	it("接受合法 provider 数组", () => {
		expect(normalizeProviderSelection(["exa", "brave"])).toEqual(["exa", "brave"]);
	});

	it("数组中全部非法时报错", () => {
		expect(() => normalizeProviderSelection(["bing", "google"])).toThrow(/must contain at least one/);
	});
});

describe("resolveRequestedProvider", () => {
	it("参数优先于配置", () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify({ provider: "brave" }));
		clearWebSearchConfigCache();
		expect(resolveRequestedProvider("exa")).toBe("exa");
	});

	it("参数缺失时使用配置默认值", () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify({ provider: "openai" }));
		clearWebSearchConfigCache();
		expect(resolveRequestedProvider(undefined)).toBe("openai");
	});
});

describe("autoSearchOrder", () => {
	it("默认 Exa 优先", () => {
		expect(autoSearchOrder(undefined)).toEqual(["exa", "brave", "openai"]);
	});

	it("Codex 会话下 OpenAI 优先", () => {
		expect(autoSearchOrder({ model: { provider: "openai-codex" } } as never)).toEqual(["openai", "exa", "brave"]);
	});

	it("配置的 searchProviderOrder 覆盖默认顺序", () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify({ searchProviderOrder: ["brave", "exa"] }));
		clearWebSearchConfigCache();
		expect(autoSearchOrder(undefined)).toEqual(["brave", "exa"]);
	});
});

describe("search 调度", () => {
	it("显式 provider 失败时不静默切换到其他来源", async () => {
		providers.brave.search.mockRejectedValue(new Error("brave down"));
		await expect(search("q", {}, "brave")).rejects.toThrow("brave down");
		expect(providers.exa.search).not.toHaveBeenCalled();
	});

	it("auto 模式按顺序回退直到成功", async () => {
		providers.exa.search.mockRejectedValue(new Error("exa down"));
		providers.brave.search.mockResolvedValue({ answer: "brave answer", results: [] });
		const result = await search("q", {}, "auto");
		expect(result.provider).toBe("brave");
		expect(providers.openai.search).not.toHaveBeenCalled();
	});

	it("auto 模式全部失败时汇总错误", async () => {
		providers.exa.search.mockRejectedValue(new Error("exa down"));
		providers.brave.search.mockRejectedValue(new Error("brave down"));
		providers.openai.search.mockRejectedValue(new Error("openai down"));
		await expect(search("q", {}, "auto")).rejects.toThrow(/No search provider available/);
	});

	it("取消错误不会触发回退", async () => {
		providers.exa.search.mockRejectedValue(new Error("Aborted"));
		await expect(search("q", {}, "auto")).rejects.toThrow("Aborted");
		expect(providers.brave.search).not.toHaveBeenCalled();
	});

	it("数组 provider 并发聚合去重结果", async () => {
		providers.exa.search.mockResolvedValue({ answer: "exa answer", results: [{ title: "a", url: "https://x.com/a", snippet: "" }] });
		providers.brave.search.mockResolvedValue({ answer: "brave answer", results: [{ title: "a", url: "https://x.com/a", snippet: "" }, { title: "b", url: "https://x.com/b", snippet: "" }] });
		const result = await search("q", {}, ["exa", "brave"]);
		expect(result.results).toHaveLength(2);
		expect(result.answer).toContain("Exa");
		expect(result.answer).toContain("Brave");
	});

	it("数组 provider 部分失败时仍返回成功结果并附带错误说明", async () => {
		providers.exa.search.mockResolvedValue({ answer: "exa answer", results: [] });
		providers.brave.search.mockRejectedValue(new Error("brave down"));
		const result = await search("q", {}, ["exa", "brave"]);
		expect(result.answer).toContain("Provider errors");
		expect(result.answer).toContain("brave down");
	});

	it("数组 provider 全部失败时报错", async () => {
		providers.exa.search.mockRejectedValue(new Error("exa down"));
		providers.brave.search.mockRejectedValue(new Error("brave down"));
		await expect(search("q", {}, ["exa", "brave"])).rejects.toThrow(/Selected-provider search failed/);
	});
});
