import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTER_PATH = path.join(__dirname, "..", "plain", "character.md");

// loadCharacter 读取 plain/character.md 中的语言习惯与处事风格，读取失败时返回空字符串
function loadCharacter(): string {
  try {
    return fs.readFileSync(CHARACTER_PATH, "utf-8").trim();
  } catch {
    return "";
  }
}

// registerCharacter 把 plain/character.md 的内容整体追加到系统提示词，始终生效
export function registerCharacter(pi: ExtensionAPI) {
  const character = loadCharacter();
  if (!character) return;

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + character,
    };
  });
}
