import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { describeCron, parseCron } from "./cron.ts";
import { createRuleId, formatRule, isTimeUnit, type AutoCompactRule, type AutoCompactType, type TimeUnit } from "./types.ts";

const TYPES: AutoCompactType[] = ["every", "idle", "cron"];
const UNITS: TimeUnit[] = ["s", "m", "h"];
const PANEL_WIDTH = 72;

interface Draft {
  id: string;
  enabled: boolean;
  type: AutoCompactType;
  value: string;
  unit: TimeUnit;
  cron: string;
  isNew: boolean;
}

// AutoCompactPanel 编辑当前会话的多条自动压缩策略；保存返回新列表，取消返回 null。
export class AutoCompactPanel implements Component {
  private rules: AutoCompactRule[];
  private selected = 0;
  private mode: "list" | "edit" = "list";
  private draft?: Draft;
  private field = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    rules: readonly AutoCompactRule[],
    private readonly onDone: (rules: AutoCompactRule[] | null) => void,
  ) {
    this.rules = rules.map((rule) => ({ ...rule }));
  }

  handleInput(data: string): void {
    if (this.mode === "edit") this.handleEdit(data);
    else this.handleList(data);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.mode === "edit" && this.draft ? this.renderEdit(width) : this.renderList(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private handleList(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onDone(null);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(Math.max(0, this.rules.length - 1), this.selected + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.space) && this.rules[this.selected]) {
      this.rules[this.selected] = { ...this.rules[this.selected]!, enabled: !this.rules[this.selected]!.enabled };
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "e") {
      const rule = this.rules[this.selected];
      if (rule) this.beginEdit(rule, false);
      return;
    }
    if (data === "a" || data === "n") {
      this.beginEdit({
        id: createRuleId(),
        enabled: true,
        type: "every",
        value: 30,
        unit: "m",
      }, true);
      return;
    }
    if ((data === "d" || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) && this.rules.length > 0) {
      this.rules.splice(this.selected, 1);
      this.selected = Math.max(0, Math.min(this.selected, this.rules.length - 1));
      this.invalidate();
      return;
    }
    if (data === "s") this.onDone(this.rules.map((rule) => ({ ...rule })));
  }

  private beginEdit(rule: AutoCompactRule, isNew: boolean): void {
    this.draft = {
      id: rule.id,
      enabled: rule.enabled,
      type: rule.type,
      value: rule.value === undefined ? "30" : String(rule.value),
      unit: rule.unit ?? "m",
      cron: rule.cron ?? "",
      isNew,
    };
    this.field = 0;
    this.mode = "edit";
    this.invalidate();
  }

  private handleEdit(data: string): void {
    const draft = this.draft;
    if (!draft) return;
    const fields = fieldNames(draft.type);
    if (matchesKey(data, Key.escape)) {
      this.mode = "list";
      this.draft = undefined;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.field = Math.max(0, this.field - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, Key.tab) && fields[this.field] !== "type" && fields[this.field] !== "unit")) {
      this.field = Math.min(fields.length - 1, this.field + 1);
      this.invalidate();
      return;
    }
    const field = fields[this.field] ?? "type";
    if ((matchesKey(data, Key.left) || matchesKey(data, Key.right)) && (field === "type" || field === "unit")) {
      const direction = matchesKey(data, Key.left) ? -1 : 1;
      if (field === "type") draft.type = cycle(TYPES, draft.type, direction);
      else draft.unit = cycle(UNITS, draft.unit, direction);
      this.field = Math.min(this.field, fieldNames(draft.type).length - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const rule = draftToRule(draft);
      if (!rule) return;
      if (draft.isNew) this.rules.push(rule);
      else {
        const index = this.rules.findIndex((item) => item.id === rule.id);
        if (index >= 0) this.rules[index] = rule;
        else this.rules.push(rule);
        this.selected = Math.max(0, index);
      }
      if (draft.isNew) this.selected = this.rules.length - 1;
      this.mode = "list";
      this.draft = undefined;
      this.invalidate();
      return;
    }
    if (field === "value") {
      if (matchesKey(data, Key.backspace)) draft.value = draft.value.slice(0, -1);
      else if (/^\d$/.test(data) && draft.value.length < 6) draft.value += data;
      else return;
      this.invalidate();
      return;
    }
    if (field === "cron") {
      if (matchesKey(data, Key.backspace)) draft.cron = draft.cron.slice(0, -1);
      else if (isPrintable(data) && draft.cron.length < 80) draft.cron += data;
      else return;
      this.invalidate();
    }
  }

  private renderList(width: number): string[] {
    const rows = this.rules.length === 0
      ? ["(没有策略，按 a 新增)"]
      : this.rules.map((rule, index) => {
        const marker = index === this.selected ? "▶" : " ";
        const flag = rule.enabled ? "开" : "关";
        return `${marker} [${flag}] ${formatRule(rule)}`;
      });
    return frame(width, "自动压缩策略", rows, "↑↓选择  Space开关  e编辑  a新增  d删除  s保存  Esc取消");
  }

  private renderEdit(width: number): string[] {
    const draft = this.draft!;
    const fields = fieldNames(draft.type);
    const rows = fields.map((name, index) => {
      const marker = index === this.field ? "▶" : " ";
      return `${marker} ${fieldLabel(name)} ${fieldValue(draft, name)}`;
    });
    const hint = draft.type === "cron"
      ? describeCron(draft.cron)
      : (Number.isInteger(Number(draft.value)) && Number(draft.value) > 0 && isTimeUnit(draft.unit) ? "数值有效" : "请输入正整数");
    rows.push(hint);
    return frame(width, draft.isNew ? "新增策略" : "编辑策略", rows, "←→/Tab切换  Enter确认  Esc返回");
  }
}

function fieldNames(type: AutoCompactType): Array<"type" | "value" | "unit" | "cron"> {
  return type === "cron" ? ["type", "cron"] : ["type", "value", "unit"];
}

function fieldLabel(field: "type" | "value" | "unit" | "cron"): string {
  if (field === "type") return "类型";
  if (field === "value") return "数值";
  if (field === "unit") return "单位";
  return "Cron";
}

function fieldValue(draft: Draft, field: "type" | "value" | "unit" | "cron"): string {
  if (field === "type") return draft.type;
  if (field === "value") return draft.value || "(空)";
  if (field === "unit") return draft.unit;
  return draft.cron || "(空)";
}

function isPrintable(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e && code !== 0x7f;
}

function cycle<T>(values: readonly T[], current: T, direction: number): T {
  const index = values.indexOf(current);
  const next = (index < 0 ? 0 : index + direction) % values.length;
  return values[(next + values.length) % values.length]!;
}

function draftToRule(draft: Draft): AutoCompactRule | undefined {
  if (draft.type === "cron") {
    const cron = draft.cron.trim();
    if (!parseCron(cron)) return undefined;
    return { id: draft.id, enabled: draft.enabled, type: "cron", cron };
  }
  const value = Number(draft.value);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return { id: draft.id, enabled: draft.enabled, type: draft.type, value, unit: draft.unit };
}

function frame(width: number, title: string, rows: string[], footer: string): string[] {
  const w = Math.max(8, Math.min(width, PANEL_WIDTH));
  const inner = w - 4;
  const border = "─".repeat(Math.max(0, w - 2));
  const line = (text: string) => `│ ${truncateToWidth(text, inner, "...", true)} │`;
  return [`┌${border}┐`, line(title), `├${border}┤`, ...rows.map(line), `├${border}┤`, line(footer), `└${border}┘`];
}
