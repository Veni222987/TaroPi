import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 图表类型 ────────────────────────────────────────────────

type DiagramType = "architecture" | "dataflow" | "deployment";
const VALID_TYPES: DiagramType[] = ["architecture", "dataflow", "deployment"];

function loadStyleReference(type: DiagramType): string {
  try {
    return readFileSync(join(__dirname, "reference", `${type}.md`), "utf-8").trim();
  } catch {
    return `请生成一张专业的 ${type} 图表。`;
  }
}

// ── OpenAI API 调用 ─────────────────────────────────────────

async function callGPT4oImage(
  apiKey: string,
  baseUrl: string,
  prompt: string,
  imageB64: string,
): Promise<string | null> {
  // 先尝试 responses API（支持 image_generation tool）
  try {
    const resp = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-2024-11-20",
        input: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: `data:image/png;base64,${imageB64}` },
            ],
          },
        ],
        tools: [{ type: "image_generation" }],
        output: { type: "image", format: "png" },
      }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as any;
      const url = data?.output?.content?.[0]?.image_url;
      if (url) return url;
    }
  } catch {
    // 降级到 chat completions
  }

  // 降级：chat completions + image_generation tool
  const resp2 = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-2024-11-20",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${prompt}\n\n请分析草图并调用 image_generation 工具生成架构图。`,
            },
            { type: "image_url", image_url: `data:image/png;base64,${imageB64}` },
          ],
        },
      ],
      tools: [{ type: "image_generation" }],
      tool_choice: "auto",
    }),
  });
  if (resp2.ok) {
    const data2 = (await resp2.json()) as any;
    for (const tc of data2?.choices?.[0]?.message?.tool_calls ?? []) {
      if (tc?.type === "image_generation") return tc.image_generation?.image_url ?? null;
    }
  }
  return null;
}

async function callDallE3(
  apiKey: string,
  baseUrl: string,
  prompt: string,
  size: string,
): Promise<string | null> {
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      size,
      response_format: "url",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DALL-E 3 API 错误 ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as any;
  return data?.data?.[0]?.url ?? null;
}

// ── 参数 Schema ─────────────────────────────────────────────

const DrawParams = Type.Object({
  input: Type.Optional(
    Type.String({
      description: "手绘草图路径（gpt-4o-image 必填；dall-e-3 忽略此参数）",
    }),
  ),
  type: Type.Optional(
    Type.String({
      description:
        "图表类型：architecture（系统架构，默认）| dataflow（数据流）| deployment（部署拓扑）",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "生成模型：gpt-4o-image（图生图，默认）| dall-e-3（文生图）",
    }),
  ),
  output: Type.Optional(
    Type.String({
      description: "输出 PNG 路径；默认在 cwd 下以时间戳命名",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: "额外的风格或内容要求，叠加在内置风格参考之上",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        "输出尺寸（仅 dall-e-3 生效）：1792x1024（默认）| 1024x1024 | 1024x1792",
    }),
  ),
});

// ── 扩展主体 ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "draw",
    label: "Draw",
    description:
      "根据手绘草图或文字描述，调用 AI 生成专业架构图 (PNG)。" +
      "支持 architecture / dataflow / deployment 三种类型，" +
      "需要 OPENAI_API_KEY 环境变量。",
    parameters: DrawParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "错误：未设置 OPENAI_API_KEY 环境变量" }],
          isError: true,
        };
      }

      const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const type = (params.type ?? "architecture") as DiagramType;
      const model = params.model ?? "gpt-4o-image";
      const size = params.size ?? "1792x1024";

      if (!VALID_TYPES.includes(type)) {
        return {
          content: [
            {
              type: "text",
              text: `错误：type 须为 architecture / dataflow / deployment，收到: "${type}"`,
            },
          ],
          isError: true,
        };
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outPath = params.output
        ? resolve(ctx.cwd, params.output)
        : resolve(ctx.cwd, `diagram-${timestamp}.png`);
      mkdirSync(dirname(outPath), { recursive: true });

      const stylePrompt = loadStyleReference(type);
      const fullPrompt = params.prompt
        ? `${stylePrompt}\n\n## 用户额外要求\n${params.prompt}`
        : stylePrompt;

      let imageUrl: string | null = null;
      try {
        if (model === "dall-e-3") {
          imageUrl = await callDallE3(apiKey, baseUrl, fullPrompt, size);
        } else {
          if (!params.input) {
            return {
              content: [{ type: "text", text: "错误：gpt-4o-image 模式需要提供 input 图片路径" }],
              isError: true,
            };
          }
          const imgPath = resolve(ctx.cwd, params.input);
          if (!existsSync(imgPath)) {
            return {
              content: [{ type: "text", text: `错误：文件不存在: ${imgPath}` }],
              isError: true,
            };
          }
          const b64 = readFileSync(imgPath).toString("base64");
          imageUrl = await callGPT4oImage(apiKey, baseUrl, fullPrompt, b64);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `错误：${err?.message ?? String(err)}` }],
          isError: true,
        };
      }

      if (!imageUrl) {
        return {
          content: [{ type: "text", text: "错误：AI 未返回图片，请检查 API 配置或重试" }],
          isError: true,
        };
      }

      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) {
        return {
          content: [{ type: "text", text: `错误：图片下载失败 (HTTP ${imgResp.status})` }],
          isError: true,
        };
      }
      writeFileSync(outPath, Buffer.from(await imgResp.arrayBuffer()));

      return {
        content: [
          {
            type: "text",
            text: `生成完成\n路径: ${outPath}\n类型: ${type}  模型: ${model}`,
          },
        ],
      };
    },
  });
}
