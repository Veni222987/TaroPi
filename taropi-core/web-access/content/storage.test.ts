import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearResults, generateId, getResult, storeFetchResult, storeResult } from "./storage.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-storage-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearResults();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearResults();
});

describe("结果存储", () => {
	it("generateId 生成非空且不重复的 id", () => {
		const a = generateId();
		const b = generateId();
		expect(a).not.toBe(b);
		expect(a.length).toBeGreaterThan(0);
	});

	it("storeResult 存储的搜索结果可按 id 检索", () => {
		const id = generateId();
		storeResult(id, { id, type: "search", timestamp: Date.now(), queries: [{ query: "q", answer: "a", results: [], error: null }] });
		const data = getResult(id);
		expect(data?.type).toBe("search");
		expect(data?.queries?.[0].query).toBe("q");
	});

	it("未知 id 返回 null", () => {
		expect(getResult("nonexistent-id")).toBeNull();
	});

	it("storeFetchResult 落盘并可重新读取", () => {
		const id = generateId();
		storeFetchResult(id, { id, type: "fetch", timestamp: Date.now(), urls: [{ url: "https://example.com", title: "t", content: "hello world", error: null }] });
		clearResults();
		const data = getResult(id);
		expect(data?.type).toBe("fetch");
		expect(data?.urls?.[0].content).toBe("hello world");
	});

	it("非法 id 写入时报错", () => {
		expect(() => storeFetchResult("../evil", { id: "../evil", type: "fetch", timestamp: Date.now(), urls: [] })).toThrow(/Invalid stored content id/);
	});

	it("clearResults 清空内存索引", () => {
		const id = generateId();
		storeResult(id, { id, type: "search", timestamp: Date.now(), queries: [] });
		clearResults();
		expect(getResult(id)).toBeNull();
	});
});
