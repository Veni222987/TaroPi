import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";
import registerPlan from "./plan/index.js";
import registerArchive from "./archive/index.ts";
import registerPermissions from "./permissions/index.js";
import registerWebAccess from "./web-access/index.ts";
import registerAskUserQuestion from "@juicesharp/rpiv-ask-user-question";
import registerCompactTools from "pi-compact-tools/extensions/compact-tools.ts";
import { registerHudFeature } from "./hud-adapt.ts";
import { register as registerModelAlias } from "./model-alias/index.js";
import { register as registerPreamble } from "./preamble/index.ts";

// registerTaroPi 注册 TaroPi 核心扩展。
export default function registerTaroPi(pi: ExtensionAPI): void {
  registerHudFeature(pi);
  registerPreamble(pi);

  // registerSubAgents(pi);
  registerAskUserQuestion(pi);
  registerPlan(pi);
  registerArchive(pi);
  registerPermissions(pi);
  registerWebAccess(pi);
  registerModelAlias(pi);
  registerCompactTools(pi);
}
