import { describe, expect, it, vi } from "vitest";
import { getHudPanels, registerHudPanel, requestHudRefresh, setHudRefreshCallback, unregisterHudPanel } from "./registry.ts";
import { c, dim, rgb } from "./theme.ts";

describe("HUD 基础设施", () => {
	it("注册、覆盖、移除面板并触发刷新", () => {
		const key = "test-hud";
		const refresh = vi.fn();
		setHudRefreshCallback(refresh);
		registerHudPanel({ key, render: () => ["first"] });
		registerHudPanel({ key, render: () => ["second"] });
		expect(getHudPanels().find((panel) => panel.key === key)?.render({} as never)).toEqual(["second"]);
		requestHudRefresh();
		expect(refresh).toHaveBeenCalledOnce();
		unregisterHudPanel(key);
		expect(getHudPanels().some((panel) => panel.key === key)).toBe(false);
	});

	it("生成 ANSI 样式字符串", () => {
		expect(rgb(1, 2, 3)).toBe("\x1b[38;2;1;2;3m");
		expect(c("text", "color")).toBe("colortext\x1b[0m");
		expect(dim("text")).toBe("\x1b[2mtext\x1b[0m");
	});
});
