import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWebSearchConfigCache } from "../config.ts";
import { assertAuthFetchUrl, authFetchRedirectGuard, resolveAuthFetchProfile } from "./auth-fetch.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-authfetch-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	clearWebSearchConfigCache();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearWebSearchConfigCache();
});

function writeConfig(content: unknown): void {
	fs.writeFileSync(path.join(tempDir, "web-search.json"), JSON.stringify(content));
	clearWebSearchConfigCache();
}

describe("resolveAuthFetchProfile", () => {
	it("未配置任何 profile 时报错", () => {
		expect(() => resolveAuthFetchProfile(true)).toThrow(/at least one authFetch profile/);
	});

	it("auth: true 在存在多个 profile 时报错", () => {
		writeConfig({ authFetch: { a: ["a.example.com"], b: ["b.example.com"] } });
		expect(() => resolveAuthFetchProfile(true)).toThrow(/exactly one authFetch profile/);
	});

	it("按名称解析 profile", () => {
		writeConfig({ authFetch: { work: { hosts: ["intranet.example.com"], cache: "off" } } });
		const profile = resolveAuthFetchProfile("work");
		expect(profile).toEqual({ name: "work", hosts: ["intranet.example.com"], cache: "off" });
	});

	it("未知 profile 名称报错", () => {
		writeConfig({ authFetch: { work: ["intranet.example.com"] } });
		expect(() => resolveAuthFetchProfile("missing")).toThrow(/Unknown authFetch profile/);
	});
});

describe("assertAuthFetchUrl", () => {
	const profile = { name: "work", hosts: ["intranet.example.com"], cache: "session" as const };

	it("要求 HTTPS", () => {
		expect(() => assertAuthFetchUrl(profile, "http://intranet.example.com/")).toThrow(/HTTPS/);
	});

	it("主机不在白名单内时拒绝", () => {
		expect(() => assertAuthFetchUrl(profile, "https://other.example.com/")).toThrow(/not allowed/);
	});

	it("子域名匹配白名单", () => {
		expect(assertAuthFetchUrl(profile, "https://api.intranet.example.com/x").hostname).toBe("api.intranet.example.com");
	});
});

describe("authFetchRedirectGuard", () => {
	const profile = { name: "work", hosts: ["intranet.example.com"], cache: "session" as const };

	it("拒绝跨源重定向", () => {
		const from = new URL("https://intranet.example.com/a");
		const to = new URL("https://attacker.example.com/b");
		expect(() => authFetchRedirectGuard(profile, from, to)).toThrow(/cross-origin redirect/);
	});

	it("允许同源重定向", () => {
		const from = new URL("https://intranet.example.com/a");
		const to = new URL("https://intranet.example.com/b");
		expect(() => authFetchRedirectGuard(profile, from, to)).not.toThrow();
	});
});
