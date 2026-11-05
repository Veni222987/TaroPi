import { compact, type ExtensionContext, type SessionBeforeCompactEvent, type SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { resolveModelAlias } from "../model-alias/store.ts";

type CompactFn = typeof compact;

// COMPACTION_LANGUAGE_INSTRUCTION 要求摘要正文使用简体中文，保留英文模板标题与原文引用。
const COMPACTION_LANGUAGE_INSTRUCTION =
  "请用简体中文撰写摘要正文；保留既定的英文标题结构，代码、命令、路径与专有名词保持原文。";

export interface CuprumCompactorDeps {
  resolveAlias?: (name: string) => string | undefined;
  compactImpl?: CompactFn;
}

// compactUsingCuprum 把所有压缩切到铜牌模型；未配置、凭证失败或请求失败时回退到会话模型。
export async function compactUsingCuprum(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  deps: CuprumCompactorDeps = {},
): Promise<SessionBeforeCompactResult | undefined> {
  if (event.signal.aborted) return { cancel: true };
  const resolveAlias = deps.resolveAlias ?? resolveModelAlias;
  const compactImpl = deps.compactImpl ?? compact;
  const alias = resolveAlias("Cu") ?? resolveAlias("Cuprum");
  if (!alias) {
    ctx.ui.notify("未配置铜牌模型 Cu，回退会话模型压缩", "warning");
    return undefined;
  }
  const separator = alias.indexOf("/");
  const model = separator > 0 ? ctx.modelRegistry.find(alias.slice(0, separator), alias.slice(separator + 1)) : undefined;
  if (!model) {
    ctx.ui.notify(`未找到铜牌模型 ${alias}，回退会话模型压缩`, "warning");
    return undefined;
  }
  const customInstructions = [event.customInstructions, COMPACTION_LANGUAGE_INSTRUCTION]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`铜牌模型凭证不可用（${auth.error}），回退会话模型压缩`, "warning");
      return undefined;
    }
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const result = await compactImpl(
      event.preparation,
      requestModel,
      auth.apiKey,
      auth.headers as Record<string, string> | undefined,
      customInstructions,
      event.signal,
      ctx.thinkingLevel,
      (requestModel, context, options) => ctx.modelRegistry.streamSimple(requestModel, context, options),
      auth.env,
    );
    if (event.signal.aborted) return { cancel: true };
    return { compaction: result };
  } catch (error) {
    if (event.signal.aborted || isAbortError(error)) return { cancel: true };
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`铜牌模型压缩失败，回退会话模型：${message}`, "warning");
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted") || error.message.includes("cancelled") || error.message.includes("canceled"));
}
