import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = path.join(__dirname, "..", "plain", "persona.md");

// loadPersona 读取 plain/persona.md 的人设文本，读取失败时返回空字符串
function loadPersona(): string {
  try {
    return fs.readFileSync(PERSONA_PATH, "utf-8").trim();
  } catch {
    return "";
  }
}

// registerPersona 把 plain/persona.md 中的人设描述整体追加到系统提示词，始终生效
export function registerPersona(pi: ExtensionAPI) {
  const persona = loadPersona();
  if (!persona) return;

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + persona,
    };
  });
}
