import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export interface SubAgentConfig {
  name: string;
  label: string;
  emoji: string;
  systemPrompt: string;
}

export interface RunSubAgentOpts {
  config: SubAgentConfig;
  task: string;
  model: any;
  modelRegistry: any;
  cwd: string;
  signal?: AbortSignal;
}

/**
 * 创建并运行一个独立的 sub-agent session。
 * sub-agent 拥有完整的 read/bash/edit/write/grep/find 工具权限。
 */
export async function runSubAgent(opts: RunSubAgentOpts): Promise<string> {
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => opts.config.systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage: AuthStorage.create(),
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    tools: ["read", "bash", "edit", "write", "grep", "find"],
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoader: loader,
  });

  let output = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(opts.task);
  } finally {
    session.dispose();
  }

  return output;
}
