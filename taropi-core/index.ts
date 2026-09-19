import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";
import { registerAdditionally } from "./additionally/index.js";
import registerPlan from "./plan/index.js";
import { registerLoop } from "./loop/index.js";
import registerPermissions from "./permissions/index.js";
import registerWebAccess from "pi-web-access/index.ts";
import registerAskUserQuestion from "@juicesharp/rpiv-ask-user-question";
import { registerHud } from "./hud/index.js";
import { requestHudRefresh, unregisterHudPanel } from "./hud/registry.ts";
import { register as registerModelAlias } from "./model-alias/index.js";

export default function (pi: ExtensionAPI) {
  // 兼容热重载前注册的旧 todo HUD provider；当前版本不再提供 todo 功能。
  unregisterHudPanel("todo");

  // registerSubAgents(pi);
  registerAdditionally(pi);
  registerAskUserQuestion(pi);
  registerPlan(pi);
  registerLoop(pi);
  registerPermissions(pi);
  registerWebAccess(pi);
  registerHud(pi);
  requestHudRefresh();
  registerModelAlias(pi);
}
