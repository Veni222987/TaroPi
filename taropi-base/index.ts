import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";
import { registerAdditionally } from "./additionally/index.js";
import registerPlanMode from "./plan-mode/index.js";
import { registerChinese } from "./chinese/index.js";

export default function (pi: ExtensionAPI) {
  registerSubAgents(pi);
  registerAdditionally(pi);
  registerPlanMode(pi);
  registerChinese(pi);
}
