import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPreamblePath, loadPreamble } from "./config.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taropi-preamble-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("PREAMBLE.md 配置加载", () => {
  it("跟随 PI_CODING_AGENT_DIR 定位配置文件", () => {
    expect(getPreamblePath()).toBe(path.join(tempDir, "PREAMBLE.md"));
  });

  it("默认定位到 Pi 的 agent 配置目录", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(getPreamblePath()).toBe(path.join(os.homedir(), ".pi", "agent", "PREAMBLE.md"));
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  it("文件缺失或空白时不提供角色文本，也不创建文件", () => {
    const missingDir = path.join(tempDir, "missing");
    expect(loadPreamble(path.join(missingDir, "PREAMBLE.md"))).toEqual({ path: path.join(missingDir, "PREAMBLE.md") });
    expect(fs.existsSync(missingDir)).toBe(false);
    expect(loadPreamble()).toEqual({ path: path.join(tempDir, "PREAMBLE.md") });
    fs.writeFileSync(path.join(tempDir, "PREAMBLE.md"), " \n\t ");
    expect(loadPreamble()).toEqual({ path: path.join(tempDir, "PREAMBLE.md") });
  });

  it("读取并规范化中文多行角色文本", () => {
    fs.writeFileSync(path.join(tempDir, "PREAMBLE.md"), "\n你是专业编程助手。\n默认使用简体中文。\n");
    expect(loadPreamble()).toEqual({
      path: path.join(tempDir, "PREAMBLE.md"),
      preamble: "你是专业编程助手。\n默认使用简体中文。",
    });
  });

  it("读取失败时返回错误并保持降级信息", () => {
    fs.mkdirSync(path.join(tempDir, "PREAMBLE.md"));
    const result = loadPreamble();
    expect(result.path).toBe(path.join(tempDir, "PREAMBLE.md"));
    expect(result.preamble).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});
