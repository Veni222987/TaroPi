import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PlanDecisionPage, showPlanDecision } from "./tui.ts";

const theme = { bold: (text: string) => text, fg: (_token: string, text: string) => text } as unknown as Theme;

describe("计划确认 UI", () => {
	it("回车确认，补充内容可留空，Esc/ctrl+c 明确取消", () => {
		const decide = vi.fn();
		const page = new PlanDecisionPage(theme, decide);
		page.handleInput("\r"); expect(decide).toHaveBeenLastCalledWith({ execute: true });
		page.handleInput("\x1b[B"); page.handleInput("补充"); page.handleInput("\r");
		expect(decide).toHaveBeenLastCalledWith({ execute: false, feedback: "补充" });
		page.handleInput("\x1b"); expect(decide).toHaveBeenLastCalledWith({ execute: false, cancelled: true });
		page.handleInput("\x03"); expect(decide).toHaveBeenLastCalledWith({ execute: false, cancelled: true });
	});
	it("中断信号取消，dispose 清理监听，中文路径在窄屏不越界", () => {
		const controller = new AbortController(); const decide = vi.fn();
		const page = new PlanDecisionPage(theme, decide, "中文路径".repeat(20), controller.signal);
		for (const width of [10, 40, 80]) for (const line of page.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		controller.abort(); expect(decide).toHaveBeenCalledWith({ execute: false, cancelled: true });
		const controller2 = new AbortController(); const closed = new PlanDecisionPage(theme, decide, undefined, controller2.signal);
		closed.dispose(); decide.mockClear(); controller2.abort(); expect(decide).not.toHaveBeenCalled();
	});
	it("RPC 用 select/input，取消补充不冒充反馈，无 UI 不能批准", async () => {
		const select = vi.fn(async () => "补充内容" as string | undefined);
		const input = vi.fn(async () => undefined as string | undefined);
		const custom = vi.fn();
		const ctx = { hasUI: true, mode: "rpc", ui: { select, input, custom } } as unknown as ExtensionContext;
		expect(await showPlanDecision(ctx, "1. 实施")).toEqual({ execute: false, cancelled: true });
		select.mockResolvedValueOnce("开始实施"); expect(await showPlanDecision(ctx, "1. 实施")).toEqual({ execute: true });
		select.mockResolvedValueOnce(undefined); expect(await showPlanDecision(ctx, "1. 实施")).toEqual({ execute: false, cancelled: true });
		expect(custom).not.toHaveBeenCalled();
		await expect(showPlanDecision({ ...ctx, hasUI: false }, "1. 实施")).rejects.toThrow("没有确认 UI");
	});
});
