import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PreambleLoadResult {
  path: string;
  preamble?: string;
  error?: string;
}

// getPreamblePath 返回 TaroPi 全局角色文本的配置路径。
export function getPreamblePath(): string {
  return join(getAgentDir(), "PREAMBLE.md");
}

// loadPreamble 读取全局角色文本，缺失、空白或失败时安全降级。
export function loadPreamble(path = getPreamblePath()): PreambleLoadResult {
  if (!existsSync(path)) return { path };

  try {
    const preamble = readFileSync(path, "utf-8").trim();
    return preamble ? { path, preamble } : { path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, error: message };
  }
}
