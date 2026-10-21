import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelAlias } from "../model-alias/store.ts";
import { switchPlanModel } from "./runtime.ts";

vi.mock("../model-alias/store.ts", () => ({ resolveModelAlias: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });
function setup() {
	const model = { provider: "test", id: "model/id" };
	const find = vi.fn(() => model);
	const notify = vi.fn(); const setModel = vi.fn(async () => true);
	const ctx = { model: { provider: "test", id: "original" }, modelRegistry: { find }, ui: { notify } } as unknown as ExtensionContext;
	const pi = { setModel } as unknown as ExtensionAPI;
	return { model, find, notify, setModel, ctx, pi };
}
describe("阶段默认模型切换", () => {
	it("支持别名、provider/model-id 的多级 id，当前模型相同不重复切换", async () => {
		const { model, find, setModel, pi, ctx } = setup();
		vi.mocked(resolveModelAlias).mockReturnValue("test/model/id");
		await switchPlanModel(pi, ctx, "Au"); expect(find).toHaveBeenCalledWith("test", "model/id");
		expect(setModel).toHaveBeenCalledWith(model);
		setModel.mockClear(); await switchPlanModel(pi, { ...ctx, model: model as ExtensionContext["model"] }, "Aurum"); expect(setModel).not.toHaveBeenCalled();
		vi.mocked(resolveModelAlias).mockReturnValue(undefined); await switchPlanModel(pi, ctx, "test/model/id"); expect(setModel).toHaveBeenCalledTimes(1);
	});
	it("模型缺失、无凭证、异常都保留当前模型并提示；禁用切换不调用 API", async () => {
		const { notify, setModel, pi, ctx } = setup();
		await switchPlanModel(pi, ctx, undefined); expect(setModel).not.toHaveBeenCalled();
		await switchPlanModel(pi, ctx, "Ag"); expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("未找到"), "warning");
		setModel.mockResolvedValueOnce(false); await switchPlanModel(pi, ctx, "test/model/id"); expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("凭证"), "warning");
		setModel.mockRejectedValueOnce(new Error("失败")); await switchPlanModel(pi, ctx, "test/model/id"); expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("失败"), "warning");
	});
});
