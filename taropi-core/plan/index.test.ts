import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { planningFailureReason } from "./index.ts";

function response(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return { stopReason, errorMessage } as AssistantMessage;
}

describe("计划请求失败恢复", () => {
	it("返回模型错误详情", () => {
		expect(planningFailureReason(response("error", "模块加载失败"))).toBe("模块加载失败");
	});

	it("为取消和无详情错误提供默认原因", () => {
		expect(planningFailureReason(response("aborted"))).toBe("请求已取消");
		expect(planningFailureReason(response("error"))).toBe("模型请求失败");
	});

	it("正常响应不触发失败恢复", () => {
		expect(planningFailureReason(response("stop"))).toBeUndefined();
		expect(planningFailureReason(undefined)).toBeUndefined();
	});
});
