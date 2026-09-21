import { describe, expect, it, vi } from "vitest";
import { fetchRemoteUrl, validateRemoteUrl } from "./ssrf-protection.ts";

describe("SSRF 防护", () => {
	it("拒绝非 HTTP(S) 协议", async () => {
		await expect(validateRemoteUrl("ftp://example.com")).rejects.toThrow(/HTTP and HTTPS/);
	});

	it("拒绝 localhost", async () => {
		await expect(validateRemoteUrl("http://localhost/")).rejects.toThrow(/Blocked internal hostname/);
	});

	it("拒绝私有 IPv4 地址", async () => {
		await expect(validateRemoteUrl("http://127.0.0.1/")).rejects.toThrow(/Blocked internal address/);
		await expect(validateRemoteUrl("http://10.0.0.5/")).rejects.toThrow(/Blocked internal address/);
		await expect(validateRemoteUrl("http://192.168.1.1/")).rejects.toThrow(/Blocked internal address/);
	});

	it("DNS 解析到私有地址时拒绝", async () => {
		const lookup = vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
		await expect(validateRemoteUrl("http://internal.example.com/", { lookup })).rejects.toThrow(/Blocked internal address/);
	});

	it("允许公网地址通过", async () => {
		const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		const url = await validateRemoteUrl("http://public.example.com/", { lookup });
		expect(url.hostname).toBe("public.example.com");
	});

	it("allowRanges 可豁免特定网段", async () => {
		await expect(validateRemoteUrl("http://198.18.0.1/", { allowRanges: ["198.18.0.0/15"] })).resolves.toBeInstanceOf(URL);
	});

	it("domainPolicy.deny 优先于 allow 生效", async () => {
		const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		await expect(validateRemoteUrl("http://blocked.example.com/", { lookup, domainPolicy: { allow: ["blocked.example.com"], deny: ["blocked.example.com"] } })).rejects.toThrow(/Blocked hostname/);
	});

	it("domainPolicy.allow 非空时只允许列表内主机", async () => {
		const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		await expect(validateRemoteUrl("http://other.example.com/", { lookup, domainPolicy: { allow: ["good.example.com"], deny: [] } })).rejects.toThrow(/not allowed/);
	});

	it("非法 CIDR 报错", async () => {
		await expect(validateRemoteUrl("http://93.184.216.34/", { allowRanges: ["not-a-cidr"] })).rejects.toThrow(/Invalid CIDR/);
	});
});

describe("fetchRemoteUrl 重定向", () => {
	it("跟随同源重定向直到成功响应", async () => {
		const first = new Response(null, { status: 302, headers: { location: "https://public.example.com/final" } });
		const final = new Response("ok", { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(final);
		const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		const response = await fetchRemoteUrl("https://public.example.com/start", {}, { lookup });
		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		fetchSpy.mockRestore();
	});

	it("重定向到内网地址时拒绝", async () => {
		const first = new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(first);
		const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		await expect(fetchRemoteUrl("https://public.example.com/start", {}, { lookup })).rejects.toThrow(/Blocked internal address/);
		fetchSpy.mockRestore();
	});

	it("超过最大重定向次数时报错", async () => {
		const redirect = () => new Response(null, { status: 302, headers: { location: "https://public.example.com/next" } });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => redirect());
		const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		await expect(fetchRemoteUrl("https://public.example.com/start", {}, { lookup, maxRedirects: 2 })).rejects.toThrow(/Too many redirects/);
		fetchSpy.mockRestore();
	});
});
