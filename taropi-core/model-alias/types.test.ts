import { describe, expect, it } from "vitest";
import { modelsToChoices } from "./types.ts";

describe("模型选择项", () => {
	it("保留 provider、id 和可读标签", () => {
		const choices = modelsToChoices([
			{ provider: "openai", id: "gpt", name: "GPT" },
			{ provider: "local", id: "same", name: "same" },
		] as never);
		expect(choices).toEqual([
			{ provider: "openai", id: "gpt", name: "GPT", providerModelId: "openai/gpt", label: "gpt  GPT" },
			{ provider: "local", id: "same", name: "same", providerModelId: "local/same", label: "same  " },
		]);
	});
});
