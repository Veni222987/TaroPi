import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { exaProvider, hasExaApiKey } from "./exa.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-exa-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
	delete process.env.EXA_API_KEY;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.EXA_API_KEY;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
	vi.restoreAllMocks();
});

describe("exaProvider", () => {
	it("始终可用（有 Key 走 API，无 Key 走 MCP）", () => {
		expect(exaProvider.isAvailable()).toBe(true);
	});

	it("hasExaApiKey 反映是否配置了独立密钥", () => {
		expect(hasExaApiKey()).toBe(false);
		process.env.EXA_API_KEY = "test-key";
		expect(hasExaApiKey()).toBe(true);
	});

	it("有 Key 时调用 /answer 接口", async () => {
		process.env.EXA_API_KEY = "test-key";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ answer: "the answer", citations: [{ title: "Src", url: "https://x.com" }] }), { status: 200 }));
		const result = await exaProvider.search("q", {});
		expect(result?.answer).toBe("the answer");
		expect(String(fetchSpy.mock.calls[0][0])).toContain("/answer");
	});

	it("includeContent 时调用 /search 接口", async () => {
		process.env.EXA_API_KEY = "test-key";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [{ title: "Src", url: "https://x.com", text: "full text", highlights: ["hl"] }] }), { status: 200 }));
		const result = await exaProvider.search("q", { includeContent: true });
		expect(result?.inlineContent?.[0].content).toBe("full text");
		expect(String(fetchSpy.mock.calls[0][0])).toContain("/search");
	});
});

describe("exaProvider（无 Key，走 mcporter MCP）", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.resetModules();
	});

	it("无 Key 时通过 mcporter 调用托管 MCP", async () => {
		vi.doMock("node:child_process", () => ({
			execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
				cb(null, JSON.stringify({ content: [{ type: "text", text: "Title: T\nURL: https://mcp.example.com\nHighlights:\nsome content" }] }), "");
				return { kill: () => {} };
			},
		}));
		const { exaProvider: freshExaProvider } = await import("./exa.ts");
		const result = await freshExaProvider.search("q", {});
		expect(result?.results[0].url).toBe("https://mcp.example.com");
	});

	it("mcporter 缺失时给出安装提示", async () => {
		vi.doMock("node:child_process", () => ({
			execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
				const err = new Error("spawn mcporter ENOENT") as NodeJS.ErrnoException;
				cb(err, "", "");
				return { kill: () => {} };
			},
		}));
		const { exaProvider: freshExaProvider } = await import("./exa.ts");
		await expect(freshExaProvider.search("q", {})).rejects.toThrow(/mcporter CLI is required/);
	});
});
