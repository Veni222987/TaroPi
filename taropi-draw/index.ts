import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// ── 动态读取环境变量（问题 1）──────────────────────────────
// process.env 在 pi 启动时快照，source ~/.bashrc 对已运行进程无效。
// 此函数优先读进程环境，缺失时 fork shell 动态求值，并缓存回 process.env。

function resolveEnv(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const val = execSync(`bash -i -c 'echo $${key}' 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (val) process.env[key] = val; // 缓存，避免重复 fork
    return val;
  } catch {
    return "";
  }
}

// ── API 调用 ────────────────────────────────────────────────

async function callGptImage2(
  apiKey: string,
  baseUrl: string,
  prompt: string,
  size: string,
  model: string,
): Promise<string> {
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1, size }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${model} API 错误 ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as any;
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${model} 未返回图片数据，响应: ${JSON.stringify(data).slice(0, 300)}`);
  return `data:image/png;base64,${b64}`;
}

// ── 参数 Schema ─────────────────────────────────────────────

const DrawParams = Type.Object({
  type: Type.Optional(
    Type.String({
      description:
        "图表类型：architecture（系统架构，默认）| dataflow（数据流）| deployment（部署拓扑）",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "生成模型，默认 gpt-image-2；可传入任意兼容 /images/generations 的模型名",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        "输出尺寸（gpt-image-2）：1024x1024（默认）| 1536x1024 | 1024x1536 | auto",
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
  apiKey: Type.Optional(
    Type.String({
      description: "临时覆盖 TAROPI_DRAW_KEY，不填则读环境变量（问题 3）",
    }),
  ),
  baseUrl: Type.Optional(
    Type.String({
      description: "临时覆盖 TAROPI_DRAW_URL，不填则读环境变量（问题 3）",
    }),
  ),
});

// ── 扩展主体 ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "draw",
    label: "Draw",
    description:
      "根据文字描述，调用 gpt-image-2 生成专业架构图 (PNG)。" +
      "支持 architecture / dataflow / deployment 三种类型，" +
      "需要 TAROPI_DRAW_KEY 环境变量（或通过 apiKey 参数临时传入）。",
    parameters: DrawParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      // ── 解析 API 凭证（问题 1 & 3）──────────────────────
      const apiKey = params.apiKey || resolveEnv("TAROPI_DRAW_KEY");
      const baseUrl = (
        params.baseUrl ||
        resolveEnv("TAROPI_DRAW_URL") ||
        "https://api.openai.com/v1"
      ).replace(/\/$/, "");

      if (!apiKey) {
        return {
          content: [{
            type: "text",
            text: [
              "错误：未能获取 TAROPI_DRAW_KEY",
              "",
              "诊断：",
              `  - process.env.TAROPI_DRAW_KEY: ${process.env.TAROPI_DRAW_KEY ? "已设置" : "未设置"}`,
              `  - Shell 动态读取 (~/.bashrc): 失败`,
              "",
              "解决方式（任选一）：",
              "  1. 重启 pi —— 让新进程继承已 export 的环境变量",
              "  2. 确认 ~/.bashrc 中有 export TAROPI_DRAW_KEY=xxx（注意要有 export）",
              "  3. 临时传参：draw apiKey=sk-xxx ...",
            ].join("\n"),
          }],
          isError: true,
        };
      }

      // ── 解析其余参数 ─────────────────────────────────────
      const type = (params.type ?? "architecture") as DiagramType;
      const model = params.model ?? "gpt-image-2";
      const size = params.size ?? "1024x1024";

      if (!VALID_TYPES.includes(type)) {
        return {
          content: [{
            type: "text",
            text: `错误：type 须为 architecture / dataflow / deployment，收到: "${type}"`,
          }],
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

      // ── 调用 API（问题 6：进度反馈）────────────────────
      onUpdate?.(`🎨 正在调用 ${model} 生成图表（通常需要 10~30 秒）...`);

      let imageDataOrUrl: string;
      try {
        imageDataOrUrl = await callGptImage2(apiKey, baseUrl, fullPrompt, size, model);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `错误：${err?.message ?? String(err)}` }],
          isError: true,
        };
      }

      // ── 写文件 ───────────────────────────────────────────
      onUpdate?.("💾 写入文件...");
      if (imageDataOrUrl.startsWith("data:")) {
        const b64Data = imageDataOrUrl.split(",")[1];
        writeFileSync(outPath, Buffer.from(b64Data, "base64"));
      } else {
        onUpdate?.("⬇️  下载图片...");
        const imgResp = await fetch(imageDataOrUrl);
        if (!imgResp.ok) {
          return {
            content: [{ type: "text", text: `错误：图片下载失败 (HTTP ${imgResp.status})` }],
            isError: true,
          };
        }
        writeFileSync(outPath, Buffer.from(await imgResp.arrayBuffer()));
      }

      return {
        content: [{
          type: "text",
          text: `✅ 生成完成\n路径: ${outPath}\n类型: ${type}  模型: ${model}  尺寸: ${size}`,
        }],
      };
    },
  });
}
