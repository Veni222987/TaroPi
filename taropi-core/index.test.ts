import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerCompactTools from "pi-compact-tools/extensions/compact-tools.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@juicesharp/rpiv-ask-user-question", () => ({ default: vi.fn() }));
vi.mock("./hud-adapt.ts", () => ({ registerHudFeature: vi.fn() }));
vi.mock("./model-alias/index.js", () => ({ register: vi.fn() }));
vi.mock("./preamble/index.ts", () => ({ register: vi.fn() }));
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
	it("实际调用上游工厂一次，注册命令和渲染器，不修改工具、上下文或配置", async () => {
		isolation.agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-compact-tools-"));
		const api = {
			on: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(), registerToolRenderer: vi.fn(), registerMarkdownTransformer: vi.fn(),
			registerTool: vi.fn(), setActiveTools: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(), sendUserMessage: vi.fn(),
		};
		registerTaroPi(api as unknown as ExtensionAPI);
		expect(registerCompactTools).toHaveBeenCalledExactlyOnceWith(api);
		expect(api.registerCommand.mock.calls.map(([name]) => name)).toEqual(["silent", "compact-tools"]);
		expect(api.registerToolRenderer).toHaveBeenCalledTimes(1);
		expect(api.registerMarkdownTransformer).toHaveBeenCalledTimes(1);
		const forbiddenHooks = ["context", "context_with_system", "before_provider_request", "before_agent_start", "turn_end"];
		expect(api.on.mock.calls.map(([name]) => name).filter((name) => forbiddenHooks.includes(name))).toEqual([]);
		for (const method of [api.registerTool, api.setActiveTools, api.setModel, api.setThinkingLevel, api.appendEntry, api.sendMessage, api.sendUserMessage]) expect(method).not.toHaveBeenCalled();
		const notify = vi.fn();
		const command = api.registerCommand.mock.calls.find(([name]) => name === "compact-tools")![1];
		await command.handler("status", { cwd: isolation.agentDir, mode: "rpc", hasUI: false, isProjectTrusted: () => false, ui: { notify } } as unknown as ExtensionContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("compact"), "info");
		expect(fs.readdirSync(isolation.agentDir)).toEqual([]);
		for (const [event, handler] of api.on.mock.calls) if (event === "session_shutdown") handler({ reason: "exit" });
	});
});
