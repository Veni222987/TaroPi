import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { runSubAgent, type SubAgentConfig } from "./runner";
import { debuggerAgent } from "./debugger";
import { developerAgent } from "./developer";

const SUB_AGENTS: SubAgentConfig[] = [debuggerAgent, developerAgent];

async function dispatchSubAgent(
  agent: SubAgentConfig,
  task: string,
  pi: ExtensionAPI,
  ctx: any,
) {
  ctx.ui.notify(`${agent.emoji} ${agent.label} sub-agent 工作中...`, "info");
  const result = await runSubAgent({
    config: agent,
    task,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    cwd: ctx.cwd,
    signal: ctx.signal,
  });
  pi.sendMessage({
    customType: `taropi-base-${agent.name}`,
    content: result || "(sub-agent 无输出)",
    display: true,
    details: { agent: agent.name, task },
  });
  ctx.ui.notify(`${agent.label} sub-agent 完成`, "info");
}

export function register(pi: ExtensionAPI) {
  // 注册 /command
  for (const agent of SUB_AGENTS) {
    (pi.registerCommand as any)(agent.name, {
      description: `启动 ${agent.label} sub-agent`,
      argumentHint: "<任务描述>",
      handler: async (args: string, ctx: any) => {
        if (!args) {
          ctx.ui.notify(`用法: /${agent.name} <任务描述>`, "error");
          return;
        }
        await ctx.waitForIdle();
        await dispatchSubAgent(agent, args, pi, ctx);
      },
    });
  }

  // 拦截 # 前缀
  pi.on("input", async (event, ctx) => {
    for (const agent of SUB_AGENTS) {
      const prefix = `#${agent.name}`;
      if (event.text === prefix || event.text.startsWith(prefix + " ")) {
        const task = event.text.slice(prefix.length).trim();
        if (!task) {
          ctx.ui.notify(`用法: #${agent.name} <任务描述>`, "error");
          return { action: "handled" };
        }
        await dispatchSubAgent(agent, task, pi, ctx);
        return { action: "handled" };
      }
    }
    return { action: "continue" };
  });

  // 注册 tool
  for (const agent of SUB_AGENTS) {
    pi.registerTool({
      name: `delegate_to_${agent.name}`,
      label: `Delegate to ${agent.label}`,
      description:
        `启动一个独立的 ${agent.label} sub-agent。` +
        "与其他 sub-agent 可并行执行。sub-agent 可以读取、编辑文件并执行命令。",
      parameters: Type.Object({
        task: Type.String({ description: `${agent.label} 任务描述` }),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        onUpdate?.({
          content: [{ type: "text", text: `${agent.emoji} ${agent.label} sub-agent 启动中...\n` }],
          details: {},
        });
        const result = await runSubAgent({
          config: agent,
          task: params.task,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          cwd: ctx.cwd,
          signal: ctx.signal,
        });
        return {
          content: [{ type: "text", text: result || "(sub-agent 无输出)" }],
          details: {},
        };
      },
    });
  }
}
