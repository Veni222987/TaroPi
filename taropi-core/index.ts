import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";
import { registerAdditionally } from "./additionally/index.js";
import registerPlanWithTodo from "./plan-with-todo/index.js";
import { registerTodo } from "./todo/index.js";
import { registerCharacter } from "./character/index.js";
import registerPermissions from "./permissions/index.js";
import registerWebAccess from "pi-web-access/index.ts";
import registerAskUserQuestion from "@juicesharp/rpiv-ask-user-question";
import { registerHud } from "./hud/index.js";

export default function (pi: ExtensionAPI) {
  registerSubAgents(pi);
  registerAdditionally(pi);
  registerAskUserQuestion(pi);
  const todo = registerTodo(pi);
  registerPlanWithTodo(pi, todo);
  registerCharacter(pi);
  registerPermissions(pi);
  registerWebAccess(pi);
  registerHud(pi);
}
