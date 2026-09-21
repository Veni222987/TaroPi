import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { braveProvider } from "./brave.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-brave-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	delete process.env.BRAVE_API_KEY;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.BRAVE_API_KEY;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
	vi.restoreAllMocks();
});

describe("braveProvider.isAvailable", () => {
	it("无密钥时不可用", () => {
		expect(braveProvider.isAvailable()).toBe(false);
	});

	it("环境变量提供密钥时可用", () => {
		process.env.BRAVE_API_KEY = "test-key";
		expect(braveProvider.isAvailable()).toBe(true);
	});
});

describe("braveProvider.search", () => {
	it("无密钥时抛出说明性错误", async () => {
		await expect(braveProvider.search("query", {})).rejects.toThrow(/API key not found/);
	});

	it("成功时映射结果并截断到 numResults", async () => {
		process.env.BRAVE_API_KEY = "test-key";
		const body = { web: { results: [{ title: "A", url: "https://a.com", description: "desc-a" }, { title: "B", url: "https://b.com", description: "desc-b" }] } };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
		const result = await braveProvider.search("query", { numResults: 1 });
		expect(result.results).toHaveLength(1);
		expect(result.results[0].url).toBe("https://a.com");
		expect(result.answer).toContain("desc-a");
	});

	it("HTTP 错误时抛出并脱敏密钥", async () => {
		process.env.BRAVE_API_KEY = "super-secret-key";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized super-secret-key", { status: 401 }));
		await expect(braveProvider.search("query", {})).rejects.toThrow(/\[redacted\]/);
	});
});
