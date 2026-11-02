import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { compactUsingCuprum } from "./compactor.ts";

function event(aborted = false): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 10, fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: aborted ? AbortSignal.abort() : new AbortController().signal,
  } as unknown as SessionBeforeCompactEvent;
}

function context(): ExtensionContext & { notify: ReturnType<typeof vi.fn>; find: ReturnType<typeof vi.fn>; auth: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const find = vi.fn(() => ({ provider: "qq", id: "cuprum", baseUrl: "old" }));
  const auth = vi.fn(async () => ({ ok: true, apiKey: "key", headers: { a: "b" }, baseUrl: "https://cu.example", env: { X: "1" } }));
  return {
    notify,
    find,
    auth,
    thinkingLevel: "off",
    ui: { notify },
    modelRegistry: { find, getApiKeyAndHeaders: auth, streamSimple: vi.fn() },
  } as unknown as ExtensionContext & { notify: ReturnType<typeof vi.fn>; find: ReturnType<typeof vi.fn>; auth: ReturnType<typeof vi.fn> };
}

describe("铜牌模型压缩", () => {
  it("使用 Cu 的模型、凭证和流适配器，并保留准备好的切点", async () => {
    const ctx = context();
    const compactImpl = vi.fn(async () => ({ summary: "摘要", firstKeptEntryId: "kept", tokensBefore: 10 }));
    const result = await compactUsingCuprum(event(), ctx, { resolveAlias: () => "qq/cuprum", compactImpl });
    expect(result).toEqual({ compaction: { summary: "摘要", firstKeptEntryId: "kept", tokensBefore: 10 } });
    const call = compactImpl.mock.calls[0] as unknown[] | undefined;
    expect(call?.[1]).toMatchObject({ provider: "qq", id: "cuprum", baseUrl: "https://cu.example" });
    expect(call?.[2]).toBe("key");
    expect(typeof call?.[7]).toBe("function");
  });

  it.each([
    ["未配置", undefined, "未配置铜牌模型"],
    ["找不到模型", "missing/model", "未找到铜牌模型"],
  ])("%s 时回退会话模型", async (_label, alias, warning) => {
    const ctx = context();
    ctx.find.mockReturnValueOnce(undefined);
    const compactImpl = vi.fn();
    expect(await compactUsingCuprum(event(), ctx, { resolveAlias: () => alias, compactImpl })).toBeUndefined();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining(warning), "warning");
    expect(compactImpl).not.toHaveBeenCalled();
  });

  it("凭证或请求失败回退，用户取消则取消压缩", async () => {
    const missingAuth = context();
    missingAuth.auth.mockResolvedValueOnce({ ok: false, error: "no key" });
    expect(await compactUsingCuprum(event(), missingAuth, { resolveAlias: () => "qq/cuprum", compactImpl: vi.fn() })).toBeUndefined();
    expect(missingAuth.notify).toHaveBeenCalledWith(expect.stringContaining("凭证不可用"), "warning");

    const failed = context();
    const compactImpl = vi.fn(async () => { throw new Error("provider down"); });
    expect(await compactUsingCuprum(event(), failed, { resolveAlias: () => "qq/cuprum", compactImpl })).toBeUndefined();
    expect(failed.notify).toHaveBeenCalledWith(expect.stringContaining("provider down"), "warning");

    const aborted = context();
    expect(await compactUsingCuprum(event(true), aborted, { resolveAlias: () => "qq/cuprum", compactImpl: vi.fn(async () => { throw new Error("aborted"); }) })).toEqual({ cancel: true });
    expect(aborted.notify).not.toHaveBeenCalled();
  });
});
