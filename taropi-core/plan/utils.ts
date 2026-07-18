/**
 * Pure utility functions for the /plan state machine.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const EXECUTE_PLAN_LABEL = "开始实现";
export const ADJUST_PLAN_LABEL = "补充内容";

export type PlanStatus = "planning" | "clarifying" | "implementing" | "completed";

const STATUS_LABEL: Record<PlanStatus, string> = {
  planning: "🧭 计划制定中",
  clarifying: "❔ 澄清确认中",
  implementing: "▶ 实施中",
  completed: "✓ 已完成",
};

function fmtTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// cleanStepText 清理计划步骤文本，便于生成简短 todo
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 77)}...`;
  return cleaned;
}

// extractPlanSection 提取回复中的 Plan 段落原文
export function extractPlanSection(message: string): string {
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return "";
  return message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length).trim();
}

// extractPlanSteps 从 Plan 段落提取编号步骤
export function extractPlanSteps(message: string): string[] {
  const planSection = extractPlanSection(message);
  if (!planSection) return [];

  const steps: string[] = [];
  const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;
  for (const match of planSection.matchAll(numberedPattern)) {
    const text = cleanStepText(match[2]);
    if (text.length > 3 && !text.startsWith("/")) steps.push(text);
  }
  return steps;
}

function renderPlanMarkdown(planText: string, createdAt: Date, status: PlanStatus, updatedAt?: Date): string {
  const lines = ["# Plan", "", `**创建时间**: ${fmtTimestamp(createdAt)}`];
  if (updatedAt) lines.push(`**更新时间**: ${fmtTimestamp(updatedAt)}`);
  lines.push(`**状态**: ${STATUS_LABEL[status]}`, "", "## 计划详情", "", planText.trim(), "");
  return lines.join("\n");
}

// writePlanMarkdown 创建计划 Markdown 文件
export function writePlanMarkdown(cwd: string, planText: string, status: PlanStatus): { filePath: string; createdAt: Date } {
  const plansDir = path.join(cwd, ".pi", "taropi", "plans");
  fs.mkdirSync(plansDir, { recursive: true });

  const createdAt = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}T${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}${pad(createdAt.getSeconds())}`;
  const filePath = path.join(plansDir, `${ts}plan.md`);

  fs.writeFileSync(filePath, renderPlanMarkdown(planText, createdAt, status), "utf-8");
  return { filePath, createdAt };
}

// updatePlanMarkdown 更新计划 Markdown 文件状态
export function updatePlanMarkdown(filePath: string, planText: string, createdAt: Date, status: PlanStatus): void {
  fs.writeFileSync(filePath, renderPlanMarkdown(planText, createdAt, status, new Date()), "utf-8");
}

