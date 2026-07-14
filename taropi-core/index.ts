import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";
import { registerAdditionally } from "./additionally/index.js";
import registerPlanMode from "./plan-mode/index.js";
import { registerChinese } from "./chinese/index.js";
import registerPermissions from "./permissions/index.js";
import registerWebAccess from "pi-web-access/index.ts";
import registerAskUserQuestion from "@juicesharp/rpiv-ask-user-question";

export default function (pi: ExtensionAPI) {
  registerSubAgents(pi);
  registerAdditionally(pi);
  registerPlanMode(pi);
  registerChinese(pi);
  registerPermissions(pi);
  registerWebAccess(pi);
  registerAskUserQuestion(pi);
}
