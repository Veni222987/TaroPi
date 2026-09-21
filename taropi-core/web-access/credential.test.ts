import { describe, expect, it } from "vitest";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential.ts";

describe("密钥解析", () => {
	it("字面量优先于环境变量", () => {
		expect(resolveCredential({ provider: "Test", configuredValue: "literal-key", environmentValue: "env-key" })).toBe("literal-key");
	});

	it("配置缺失时回退到环境变量", () => {
		expect(resolveCredential({ provider: "Test", configuredValue: undefined, environmentValue: "env-key" })).toBe("env-key");
	});

	it("两者都缺失返回 null", () => {
		expect(resolveCredential({ provider: "Test", configuredValue: undefined, environmentValue: undefined })).toBeNull();
	});

	it("支持 $ENV_VAR 引用", () => {
		process.env.TAROPI_TEST_KEY = "resolved-value";
		expect(resolveCredential({ provider: "Test", configuredValue: "$TAROPI_TEST_KEY" })).toBe("resolved-value");
		expect(resolveCredential({ provider: "Test", configuredValue: "${TAROPI_TEST_KEY}" })).toBe("resolved-value");
		delete process.env.TAROPI_TEST_KEY;
	});

	it("$ENV_VAR 引用为空时报错", () => {
		delete process.env.TAROPI_MISSING_KEY;
		expect(() => resolveCredential({ provider: "Test", configuredValue: "$TAROPI_MISSING_KEY" })).toThrow(/empty environment variable/);
	});

	it("不支持 !command 语法，直接报错且不执行命令", () => {
		expect(() => resolveCredential({ provider: "Test", configuredValue: "!echo pwned" })).toThrow(/not supported/);
		expect(() => hasCredentialSource({ provider: "Test", configuredValue: "!echo pwned" })).toThrow(/not supported/);
	});

	it("hasCredentialSource 正确判断可用性", () => {
		expect(hasCredentialSource({ provider: "Test", configuredValue: undefined, environmentValue: undefined })).toBe(false);
		expect(hasCredentialSource({ provider: "Test", configuredValue: "key", environmentValue: undefined })).toBe(true);
	});

	it("redactCredential 替换密钥文本", () => {
		expect(redactCredential("error: key=secret123 invalid", "secret123")).toBe("error: key=[redacted] invalid");
		expect(redactCredential("no secret here", null)).toBe("no secret here");
	});
});
