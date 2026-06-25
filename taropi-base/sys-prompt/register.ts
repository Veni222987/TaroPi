import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPEND_SYSTEM_PROMPT = readFileSync(join(__dirname, "append_system.md"), "utf-8");

export function register(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${APPEND_SYSTEM_PROMPT}`,
  }));
}
