import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";
import { registerAdditionally } from "./additionally/index.js";
import registerPlan from "./plan/index.js";
import { registerTodo } from "./todo/index.js";
import { registerCharacter } from "./character/index.js";
import registerPermissions from "./permissions/index.js";
import registerWebAccess from "pi-web-access/index.ts";
import registerAskUserQuestion from "@juicesharp/rpiv-ask-user-question";
import { registerHud } from "./hud/index.js";
import { register as registerModelAlias } from "./model-alias/index.js";

export default function (pi: ExtensionAPI) {
  registerSubAgents(pi);
  registerAdditionally(pi);
  registerAskUserQuestion(pi);
  registerTodo(pi);
  registerPlan(pi);
  registerCharacter(pi);
  registerPermissions(pi);
  registerWebAccess(pi);
  registerHud(pi);
  registerModelAlias(pi);
}
