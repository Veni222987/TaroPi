import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./index.ts";

describe("权限配置只读加载", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "taropi-permissions-"));
    path = join(directory, "permissions.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("文件不存在时只在内存中使用默认配置", () => {
    expect(loadConfig(path).externalWriteConfirm).toBe(true);
    expect(loadConfig(path).deny.length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });

  it("保留关闭状态和空规则，重复加载也不改写文件", () => {
    const text = '{ "externalWriteConfirm": false, "deny": [], "custom": 1 }\n';
    writeFileSync(path, text);
    for (let i = 0; i < 3; i++) {
      expect(loadConfig(path)).toEqual({ externalWriteConfirm: false, deny: [] });
    }
    expect(readFileSync(path, "utf-8")).toBe(text);
  });

  it("删除字段后不恢复默认限制", () => {
    writeFileSync(path, "{}");
    expect(loadConfig(path)).toEqual({ externalWriteConfirm: false, deny: [] });
    expect(readFileSync(path, "utf-8")).toBe("{}");
  });

  it("用户规则独立生效，不追加默认规则", () => {
    const deny = [{ pattern: "private/**", tool: ["read", "edit"], reason: "自定义" }];
    writeFileSync(path, JSON.stringify({ deny }));
    expect(loadConfig(path)).toEqual({ externalWriteConfirm: false, deny });
  });

  it.each([
    "{broken",
    "null",
    "[]",
    '{"externalWriteConfirm":"false"}',
    '{"deny":null}',
    '{"deny":[{}]}',
    '{"deny":[{"pattern":"x","tool":"unknown"}]}',
  ])("非法配置明确报错且不覆盖原文：%s", (text) => {
    writeFileSync(path, text);
    expect(() => loadConfig(path)).toThrow();
    expect(readFileSync(path, "utf-8")).toBe(text);
  });
});
