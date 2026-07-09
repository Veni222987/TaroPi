/**
 * Shared execution mode state for plan-mode and sub-agents.
 *
 * Ctrl+Shift+M cycles: single → parallel → chain.
 * Plan-mode reads current mode when executing a plan.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ExecMode = "single" | "parallel" | "chain";
export const MODE_CYCLE: ExecMode[] = ["single", "parallel", "chain"];

let currentModeIndex = 0;

export function getExecMode(): ExecMode {
  return MODE_CYCLE[currentModeIndex]!;
}

export function cycleExecMode(): ExecMode {
  currentModeIndex = (currentModeIndex + 1) % MODE_CYCLE.length;
  return MODE_CYCLE[currentModeIndex]!;
}

export default function registerExecMode(pi: ExtensionAPI): void {
  pi.registerShortcut("ctrl+shift+m", {
    description: "Cycle subagent execution mode",
    handler: async (ctx) => {
      const mode = cycleExecMode();
      ctx.ui.setStatus("subagent-mode", `🔀 ${mode}`);
      pi.events.emit("exec-mode:changed", mode);
    },
  });

  pi.on("session_start", async () => {
    pi.events.emit("exec-mode:changed", getExecMode());
  });
}
