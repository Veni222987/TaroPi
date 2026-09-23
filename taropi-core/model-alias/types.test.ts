import { describe, expect, it } from "vitest";
import {
  findModelByProviderModelId,
  findModelsById,
  modelsToChoices,
  parseProviderModelId,
} from "./types.ts";

const models = [
  { provider: "qq", id: "gpt-5", name: "GPT 5" },
  { provider: "openai", id: "gpt-5", name: "GPT 5" },
  { provider: "qq", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
];

describe("模型选择项", () => {
  it("保留 provider、id、name 与 provider/model-id，并保持原始顺序", () => {
    const choices = modelsToChoices(models as never);

    expect(choices).toEqual([
      { provider: "qq", id: "gpt-5", name: "GPT 5", providerModelId: "qq/gpt-5" },
      { provider: "openai", id: "gpt-5", name: "GPT 5", providerModelId: "openai/gpt-5" },
      {
        provider: "qq",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        providerModelId: "qq/claude-sonnet-5",
      },
    ]);
  });
});

describe("provider/model-id 解析与匹配", () => {
  it("解析有效格式", () => {
    expect(parseProviderModelId("qq/gpt-5")).toEqual({ provider: "qq", modelId: "gpt-5" });
  });

  it.each(["gpt-5", "/gpt-5", "qq/", "qq/gpt-5/preview", " qq/gpt-5", "qq/gpt-5 "])(
    "拒绝无效格式: %s",
    (value) => {
      expect(parseProviderModelId(value)).toBeUndefined();
    },
  );

  it("按 provider/model-id 忽略大小写精确匹配", () => {
    expect(findModelByProviderModelId(models, "QQ/GPT-5")).toEqual(models[0]);
  });

  it("未找到 provider/model-id 时返回 undefined", () => {
    expect(findModelByProviderModelId(models, "azure/gpt-5")).toBeUndefined();
  });

  it("列出同一 model-id 的全部 provider 候选", () => {
    expect(findModelsById(models, "GPT-5")).toEqual([models[0], models[1]]);
  });
});
