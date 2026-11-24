import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCompactTools from "pi-compact-tools/extensions/compact-tools.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAsk } from "./ask/index.ts";
import { registerAutoCompact } from "./auto-compact/index.ts";
import registerTaroPi from "./index.ts";

const isolation = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...await original<typeof import("@earendil-works/pi-coding-agent")>(), getAgentDir: () => isolation.agentDir,
}));
vi.mock("./sub-agents/index.js", () => ({ register: vi.fn() }));
vi.mock("./plan/index.js", () => ({ default: vi.fn() }));
vi.mock("./archive/index.ts", () => ({ default: vi.fn() }));
vi.mock("./permissions/index.js", () => ({ default: vi.fn() }));
vi.mock("./web-access/index.ts", () => ({ default: vi.fn() }));
vi.mock("./ask-user-question/index.ts", () => ({ default: vi.fn() }));
vi.mock("./ask/index.ts", () => ({ registerAsk: vi.fn() }));
vi.mock("./hud-adapt.ts", () => ({ registerHudFeature: vi.fn() }));
vi.mock("./model-alias/index.js", () => ({ register: vi.fn() }));
vi.mock("./preamble/index.ts", () => ({ register: vi.fn() }));
vi.mock("./auto-compact/index.ts", () => ({ registerAutoCompact: vi.fn() }));
vi.mock("pi-compact-tools/extensions/compact-tools.ts", async (original) => {
	const extension = await original<typeof import("pi-compact-tools/extensions/compact-tools.ts")>();
	return { ...extension, default: vi.fn(extension.default) };
});
afterEach(() => {
	vi.clearAllMocks();
	if (isolation.agentDir) fs.rmSync(isolation.agentDir, { recursive: true, force: true });
	isolation.agentDir = "";
});

describe("core 收编 compact-tools", () => {
	it("实际调用上游工厂一次，不修改工具、上下文或配置", () => {
		isolation.agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-compact-tools-"));
		const api = {
			on: vi.fn(), registerMarkdownTransformer: vi.fn(),
			registerTool: vi.fn(), setActiveTools: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(), sendUserMessage: vi.fn(),
		};
		registerTaroPi(api as unknown as ExtensionAPI);
		expect(registerCompactTools).toHaveBeenCalledExactlyOnceWith(api);
		expect(registerAutoCompact).toHaveBeenCalledExactlyOnceWith(api);
		expect(registerAsk).toHaveBeenCalledExactlyOnceWith(api);
		for (const method of [api.setActiveTools, api.setModel, api.setThinkingLevel, api.appendEntry, api.sendMessage, api.sendUserMessage]) expect(method).not.toHaveBeenCalled();
		expect(fs.readdirSync(isolation.agentDir)).toEqual([]);
		for (const [event, handler] of api.on.mock.calls) if (event === "session_shutdown") handler({ reason: "exit" });
	});
});
