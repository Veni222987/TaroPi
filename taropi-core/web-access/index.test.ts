import { describe, expect, it } from "vitest";
import registerWebAccess from "./index.ts";

describe("registerWebAccess", () => {
	it("注册四个工具且名称、参数 schema 均合法", () => {
		const registered: Array<{ name: string; parameters: unknown }> = [];
		const pi = { registerTool: (tool: { name: string; parameters: unknown }) => registered.push(tool) } as never;
		registerWebAccess(pi);
		expect(registered.map((t) => t.name).sort()).toEqual(["fetch_content", "get_search_content", "source_check", "web_search"]);
		for (const tool of registered) expect(tool.parameters).toBeDefined();
	});
});
