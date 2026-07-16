/**
 * HUD 共享主题 —— ANSI 颜色工具与看板风格定义。
 * 其他插件向 HUD 注册面板时应使用此模块提供的颜色函数保持风格一致。
 */

export const R = "\x1b[0m";
export const D = "\x1b[2m";

// rgb 生成 truecolor ANSI 前景色
export function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

// Monokai Pro 配色
export const FG = "\x1b[38;5;252m";
export const COMMENT = "\x1b[38;5;243m";
export const PINK = "\x1b[38;5;198m";
export const GREEN = "\x1b[38;5;154m";
export const ORANGE = "\x1b[38;5;208m";
export const CYAN = "\x1b[38;5;123m";
export const PURPLE = "\x1b[38;5;141m";
export const YELLOW = "\x1b[38;5;221m";
export const BLUE = "\x1b[38;5;111m";

// c 用指定颜色包裹文本，末尾自动重置
export function c(text: string, color: string): string {
  return `${color}${text}${R}`;
}

// dim 将文本渲染为暗淡色
export function dim(text: string): string {
  return `${D}${text}${R}`;
}

// SEP 分隔符，用于同行多列之间
export const SEP = `${COMMENT}│${R}`;

// DIVIDER 水平分隔线（67 字符宽）
export const DIVIDER = `${COMMENT}${"─".repeat(67)}${R}`;

// fmtDuration 将毫秒格式化为可读字符串
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** HudTheme 传给 panel 的 render() 函数，提供统一的 ANSI 颜色工具 */
export interface HudTheme {
  c: (text: string, color: string) => string;
  dim: (text: string) => string;
  sep: string;
  divider: string;
  FG: string;
  COMMENT: string;
  PINK: string;
  GREEN: string;
  ORANGE: string;
  CYAN: string;
  PURPLE: string;
  YELLOW: string;
  BLUE: string;
  R: string;
}

export const hudTheme: HudTheme = {
  c,
  dim,
  sep: SEP,
  divider: DIVIDER,
  FG,
  COMMENT,
  PINK,
  GREEN,
  ORANGE,
  CYAN,
  PURPLE,
  YELLOW,
  BLUE,
  R,
};
