/**
 * 复用 sub-agents/agents.ts 的 agent 定义发现能力，独立实现 model 别名解析。
 *
 * 刻意不 import sub-agents/engine.ts —— loop 的每一轮都是 crontab 拉起的全新
 * `pi -p --no-session` 进程，不走 sub-agent 的并发派发/HUD 状态那一套运行时。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../sub-agents/agents.ts";
import type { AgentConfig } from "../sub-agents/types.ts";
import { resolveModelAlias as resolveFromAliasStore } from "../model-alias/store.ts";

export interface ResolvedLoopAgent {
  agent: AgentConfig;
  /** 解析后的 provider/id，undefined 表示没有指定模型（沿用运行时默认） */
  model?: string;
}

// resolveModelName 三级解析：model-alias 档位名 -> models.json 的 name 反查 -> 原样返回
export function resolveModelName(modelName: string): string {
  const aliasResult = resolveFromAliasStore(modelName);
  if (aliasResult) return aliasResult;

  try {
    const modelsPath = path.join(getAgentDir(), "models.json");
    const content = fs.readFileSync(modelsPath, "utf-8");
    const config = JSON.parse(content) as {
      providers?: Record<string, { models?: Array<{ id: string; name?: string }> }>;
    };
    for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (model.name === modelName) return `${providerId}/${model.id}`;
      }
    }
  } catch {
    // 读取失败则继续原样返回
  }
  return modelName;
}

// resolveLoopAgent 按名字查找 agent 定义，解析好要用的模型（显式覆盖优先于 agent 自带的 model）
export function resolveLoopAgent(cwd: string, agentName: string, modelOverride?: string): ResolvedLoopAgent | undefined {
  const { agents } = discoverAgents(cwd, "both");
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) return undefined;

  const modelSource = modelOverride ?? agent.model;
  const model = modelSource ? resolveModelName(modelSource) : undefined;
  return { agent, model };
}
