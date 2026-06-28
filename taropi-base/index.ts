import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerSubAgents } from "./sub-agents/index.js";

export default function (pi: ExtensionAPI) {
  registerSubAgents(pi);
}
