import { describe, expect, it } from "vitest";
import { normalizeProxyUrl } from "./proxy-fetch.ts";

describe("代理 URL 规范化", () => {
	it("空值和空字符串返回 null（代表直连）", () => {
		expect(normalizeProxyUrl(undefined, "proxy")).toBeNull();
		expect(normalizeProxyUrl("", "proxy")).toBeNull();
		expect(normalizeProxyUrl("   ", "proxy")).toBeNull();
	});

	it("接受 http/https/socks 协议", () => {
		expect(normalizeProxyUrl("http://proxy:8080", "proxy")).toBe("http://proxy:8080/");
		expect(normalizeProxyUrl("socks5h://proxy:1080", "proxy")).toBe("socks5h://proxy:1080");
	});

	it("拒绝不支持的协议", () => {
		expect(() => normalizeProxyUrl("ftp://proxy:21", "proxy")).toThrow(/http:\/\/, https:\/\/, or socks/);
	});

	it("拒绝无主机名的代理地址", () => {
		expect(() => normalizeProxyUrl("http://", "proxy")).toThrow(/valid proxy URL/);
	});

	it("非法 URL 报错", () => {
		expect(() => normalizeProxyUrl("not a url", "proxy")).toThrow(/valid proxy URL/);
	});
});
