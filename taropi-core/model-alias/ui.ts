import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { AliasTier, ModelChoice } from "./types.js";
import { TIER_LABEL } from "./types.js";

// ─── AliasSettingsPage ────────────────────────────────────────

export interface AliasSettingsResult {
  tier: AliasTier;
}

/**
 * 主设置页：居中弹窗，三行档位选择。
 * ↑↓ 移动光标，Enter 进入该档位的模型选择二级页，Esc 关闭。
 * 用户选中 tier 后 resolve(results)。
 */
export class AliasSettingsPage {
  private selected = 0;
  private tiers: AliasTier[] = ["Au", "Ag", "Cu"];
  private bindings: Record<AliasTier, string | undefined>;

  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    bindings: Record<AliasTier, string | undefined>,
    private onSelect: (tier: AliasTier) => void,
    private onCancel: () => void,
  ) {
    this.bindings = bindings;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < this.tiers.length - 1) {
      this.selected++;
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect(this.tiers[this.selected]!);
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const w = Math.min(width, 56);
    const lines: string[] = [];
    const border = "─".repeat(w - 2);

    lines.push(`┌${border}┐`);
    lines.push(`│ ${truncateToWidth("模型别名设置", w - 4, "...", true)} │`);
    lines.push(`├${border}┤`);

    for (let i = 0; i < this.tiers.length; i++) {
      const tier = this.tiers[i]!;
      const bound = this.bindings[tier];
      const prefix = i === this.selected ? "▶" : " ";
      const label = TIER_LABEL[tier];
      const bindingText = bound ? `→ ${bound}` : "→ (未设置)";

      // 单行：prefix + label + binding，右半截断对齐
      const row = `${prefix} ${label}  ${bindingText}`;
      lines.push(`│ ${truncateToWidth(row, w - 4, "...", true)} │`);
    }

    lines.push(`├${border}┤`);
    lines.push(`│ ${truncateToWidth("Enter=选择模型  Esc=关闭", w - 4, "...", true)} │`);
    lines.push(`└${border}┘`);

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ─── ModelPickerPage ──────────────────────────────────────────

/**
 * 模型选择二级页：居中弹窗，列表显示所有可用模型。
 * ↑↓ 移动光标，Enter 确认选择，Esc 返回（cancel）。
 * 支持 / 搜索过滤。
 */
export class ModelPickerPage {
  private selected = 0;
  private filter = "";
  private choices: ModelChoice[];
  private filtered: ModelChoice[];

  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    choices: ModelChoice[],
    private tier: AliasTier,
    private onConfirm: (providerModelId: string) => void,
    private onCancel: () => void,
  ) {
    this.choices = choices;
    this.filtered = this.applyFilter();
  }

  private applyFilter(): ModelChoice[] {
    const q = this.filter.toLowerCase();
    if (!q) return this.choices;
    return this.choices.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.provider.toLowerCase().includes(q),
    );
  }

  handleInput(data: string): void {
    // 先处理特殊键
    if (matchesKey(data, Key.backspace)) {
      this.filter = this.filter.slice(0, -1);
      this.filtered = this.applyFilter();
      this.selected = Math.max(0, Math.min(this.selected, this.filtered.length - 1));
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.filtered.length > 0) {
        this.onConfirm(this.filtered[this.selected]!.providerModelId);
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) { this.selected--; this.invalidate(); }
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.selected < this.filtered.length - 1) { this.selected++; this.invalidate(); }
      return;
    }

    // 可打印 ASCII（0x20-0x7e），不包括控制字符和特殊序列
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7e) {
        this.filter += data;
        this.filtered = this.applyFilter();
        this.selected = Math.max(0, Math.min(this.selected, this.filtered.length - 1));
        this.invalidate();
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const w = Math.min(width, 64);
    const lines: string[] = [];
    const border = "─".repeat(w - 2);
    const tierLabel = TIER_LABEL[this.tier];

    lines.push(`┌${border}┐`);
    lines.push(`│ ${truncateToWidth(`${tierLabel} — 选择模型`, w - 4, "...", true)} │`);
    lines.push(`│ ${truncateToWidth(`搜索: ${this.filter || "(输入关键词过滤)"}`, w - 4, "...", true)} │`);
    lines.push(`├${border}┤`);

    const maxItems = Math.max(1, /* terminal height estimation */ 15);
    const start = Math.max(0, this.selected - Math.floor(maxItems / 2));
    const end = Math.min(this.filtered.length, start + maxItems);

    if (this.filtered.length === 0) {
      lines.push(`│ ${truncateToWidth("(无匹配模型)", w - 4, "...", true)} │`);
    } else {
      for (let i = start; i < end; i++) {
        const choice = this.filtered[i]!;
        const prefix = i === this.selected ? "▶" : " ";
        const itemText = `${prefix} ${choice.label}`;
        lines.push(`│ ${truncateToWidth(itemText, w - 4, "...", true)} │`);
      }
    }

    lines.push(`├${border}┤`);
    const countInfo = `${this.selected + 1}/${this.filtered.length}`;
    lines.push(
      `│ ${truncateToWidth(`${countInfo}  Enter=确认  Esc=返回  /搜索`, w - 4, "...", true)} │`,
    );
    lines.push(`└${border}┘`);

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
