import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerExecMode from "./exec-mode/index.js";
import { register as registerSubAgents } from "./sub-agents/index.js";
import { registerAdditionally } from "./additionally/index.js";
import registerPlanMode from "./plan-mode/index.js";

export default function (pi: ExtensionAPI) {
  registerExecMode(pi);
  registerSubAgents(pi);
  registerAdditionally(pi);
  registerPlanMode(pi);
}
