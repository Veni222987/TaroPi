import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSysPrompt } from "./sys-prompt/register";
import { register as registerSubAgents } from "./sub-agents/register";

export default function (pi: ExtensionAPI) {
  registerSysPrompt(pi);
  registerSubAgents(pi);
}
