import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearWebSearchConfigCache,
	loadWebSearchConfig,
	resolveApiBaseUrl,
	resolveDomainPolicy,
	resolveFetchModeConfig,
	resolveFetchTimeoutMs,
	resolveGithubCloneConfig,
	resolveMaxInlineContentChars,
	resolveSsrfConfig,
} from "./config.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-web-access-config-"));
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

describe("web-search.json 配置加载", () => {
	it("文件不存在时返回空对象", () => {
		expect(loadWebSearchConfig()).toEqual({});
	});

	it("解析失败时抛出包含路径的错误", () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), "{not json");
		clearWebSearchConfigCache();
		expect(() => loadWebSearchConfig()).toThrow(/Failed to parse/);
	});

	it("非对象根节点抛出错误", () => {
		fs.writeFileSync(path.join(tempDir, "web-search.json"), "[1,2,3]");
		clearWebSearchConfigCache();
		expect(() => loadWebSearchConfig()).toThrow(/expected a JSON object/);
	});
});

describe("resolveApiBaseUrl", () => {
	it("未配置时返回默认值", () => {
		expect(resolveApiBaseUrl({ configKey: "x", configuredValue: undefined, defaultValue: "https://default.example", environmentKey: "X", environmentValue: undefined })).toBe("https://default.example");
	});

	it("拒绝非 HTTPS 地址", () => {
		expect(() => resolveApiBaseUrl({ configKey: "x", configuredValue: "http://insecure.example", defaultValue: "https://default.example", environmentKey: "X", environmentValue: undefined })).toThrow(/HTTPS/);
	});

	it("拒绝携带凭据的地址", () => {
		expect(() => resolveApiBaseUrl({ configKey: "x", configuredValue: "https://user:pass@example.com", defaultValue: "https://default.example", environmentKey: "X", environmentValue: undefined })).toThrow(/credentials/);
	});

	it("去除结尾斜杠并优先使用环境变量", () => {
		expect(resolveApiBaseUrl({ configKey: "x", configuredValue: "https://config.example/", defaultValue: "https://default.example", environmentKey: "X", environmentValue: "https://env.example/api/" })).toBe("https://env.example/api");
	});
});

describe("resolveFetchModeConfig", () => {
	it("默认支持三种模式，默认模式为 readable", () => {
		expect(resolveFetchModeConfig({})).toEqual({ defaultMode: "readable", allowedModes: ["readable", "raw", "answer"] });
	});

	it("defaultMode 必须在 allowedModes 内", () => {
		expect(() => resolveFetchModeConfig({ fetch: { allowedModes: ["readable"], defaultMode: "raw" } })).toThrow(/fetch.defaultMode/);
	});

	it("allowedModes 为空数组时报错", () => {
		expect(() => resolveFetchModeConfig({ fetch: { allowedModes: [] } })).toThrow(/fetch.allowedModes/);
	});
});

describe("resolveFetchTimeoutMs", () => {
	it("默认 30 秒", () => {
		expect(resolveFetchTimeoutMs({})).toBe(30_000);
	});

	it("按秒换算为毫秒并向上取整", () => {
		expect(resolveFetchTimeoutMs({ fetch: { timeout: 1.5 } })).toBe(1500);
	});

	it("非正数报错", () => {
		expect(() => resolveFetchTimeoutMs({ fetch: { timeout: 0 } })).toThrow(/fetch.timeout/);
	});
});

describe("resolveDomainPolicy", () => {
	it("未配置时 allow/deny 均为空", () => {
		expect(resolveDomainPolicy({})).toEqual({ allow: [], deny: [] });
	});

	it("规范化为小写主机名", () => {
		expect(resolveDomainPolicy({ fetchContent: { domainPolicy: { allow: ["Example.COM"] } } })).toEqual({ allow: ["example.com"], deny: [] });
	});
});

describe("resolveSsrfConfig", () => {
	it("默认不信任代理且无豁免网段", () => {
		expect(resolveSsrfConfig({})).toEqual({ allowRanges: [], trustEnvProxy: false });
	});

	it("trustEnvProxy 必须是布尔值", () => {
		expect(() => resolveSsrfConfig({ ssrf: { trustEnvProxy: "yes" as never } })).toThrow(/trustEnvProxy/);
	});
});

describe("resolveGithubCloneConfig", () => {
	it("默认启用并使用默认克隆目录", () => {
		const config = resolveGithubCloneConfig({});
		expect(config.enabled).toBe(true);
		expect(config.maxRepoSizeMB).toBe(350);
	});

	it("展开 clonePath 中的 ~ 前缀", () => {
		const config = resolveGithubCloneConfig({ githubClone: { clonePath: "~/repos" } });
		expect(config.clonePath.startsWith(os.homedir())).toBe(true);
	});
});

describe("resolveMaxInlineContentChars", () => {
	it("默认 30000，且被限制在最大值内", () => {
		expect(resolveMaxInlineContentChars({})).toBe(30_000);
		expect(resolveMaxInlineContentChars({ maxInlineContentChars: 999_999 })).toBe(200_000);
	});
});

describe("配置边界组合", () => {
	it("完整配置读取一致", () => {
		writeConfig({ provider: "brave", fetch: { timeout: 5 }, maxInlineContentChars: 1000 });
		const config = loadWebSearchConfig();
		expect(config.provider).toBe("brave");
		expect(resolveFetchTimeoutMs(config)).toBe(5000);
		expect(resolveMaxInlineContentChars(config)).toBe(1000);
	});
});
