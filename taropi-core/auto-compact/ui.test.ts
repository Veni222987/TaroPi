import { describe, expect, it, vi } from "vitest";
import type { AutoCompactRule } from "./types.ts";
import { AutoCompactPanel } from "./ui.ts";

const existing: AutoCompactRule = { id: "old", enabled: true, type: "every", value: 30, unit: "m" };
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const ENTER = "\r";
const ESCAPE = "\x1b";
const SPACE = " ";

function press(panel: AutoCompactPanel, ...keys: string[]): void {
  for (const key of keys) panel.handleInput(key);
}

describe("自动压缩面板", () => {
  it("展示已有策略，支持启停、删除和保存", () => {
    const done = vi.fn();
    const panel = new AutoCompactPanel([existing], done);
    expect(panel.render(40).join("\n")).toContain("每隔 30m");
    press(panel, SPACE, "d", "s");
    expect(done).toHaveBeenLastCalledWith([]);
  });

  it("新增 every 时可切换单位，cron 只保留表达式并校验", () => {
    const done = vi.fn();
    const panel = new AutoCompactPanel([], done);
    press(panel, "a", RIGHT, DOWN, BACKSPACE, BACKSPACE, "3", "0", "0", DOWN, RIGHT, ENTER);
    expect(panel.render(80).join("\n")).toContain("闲置 300h");
    press(panel, "a", RIGHT, RIGHT, DOWN);
    for (let index = 0; index < 12; index += 1) panel.handleInput(BACKSPACE);
    for (const char of "0 3 * * *") panel.handleInput(char);
    panel.handleInput(ENTER);
    expect(panel.render(80).join("\n")).toContain("cron 0 3 * * *");
    press(panel, ESCAPE);
    expect(done).toHaveBeenLastCalledWith(null);
  });

  it("非法 cron 不能写回列表", () => {
    const done = vi.fn();
    const panel = new AutoCompactPanel([], done);
    press(panel, "a", RIGHT, RIGHT, DOWN, "x");
    panel.handleInput(ENTER);
    expect(panel.render(80).join("\n")).toContain("表达式无效");
    panel.handleInput(ESCAPE);
    panel.handleInput("s");
    expect(done).toHaveBeenCalledWith([]);
  });
});
