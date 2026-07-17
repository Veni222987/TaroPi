import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerHudPanel, requestHudRefresh } from "../hud/registry.ts";
import type { HudTheme } from "../hud/theme.ts";

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
  source?: string;
}

export interface TodoController {
  getItems(): TodoItem[];
  replace(items: string[], source?: string): void;
  complete(step: number): void;
  reopen(step: number): void;
  clear(): void;
  renderPlain(): string;
}

interface PersistedTodoState {
  items?: TodoItem[];
  expanded?: boolean;
}

const PERSIST_ENTRY_TYPE = "todo-state";
const HUD_TODO_LIMIT = 3;

const TodoToolParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("replace"),
    Type.Literal("add"),
    Type.Literal("complete"),
    Type.Literal("reopen"),
    Type.Literal("clear"),
  ], { description: "Todo operation to perform" }),
  items: Type.Optional(Type.Array(Type.String(), { description: "Items for replace action" })),
  text: Type.Optional(Type.String({ description: "Text for add action" })),
  step: Type.Optional(Type.Number({ description: "Step number for complete/reopen actions" })),
  source: Type.Optional(Type.String({ description: "Optional source identifier, e.g. a plan markdown path" })),
});

function normalizeItems(items: string[], source?: string): TodoItem[] {
  return items
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text, index) => ({ step: index + 1, text, completed: false, source }));
}

function reindex(items: TodoItem[]): TodoItem[] {
  return items.map((item, index) => ({ ...item, step: index + 1 }));
}

// registerTodo 注册独立 todo 工具、命令与 HUD 面板
export function registerTodo(pi: ExtensionAPI): TodoController {
  let items: TodoItem[] = [];
  let expanded = false;

  function persist(): void {
    pi.appendEntry(PERSIST_ENTRY_TYPE, { items, expanded } satisfies PersistedTodoState);
  }

  function refresh(): void {
    requestHudRefresh();
  }

  function renderPlain(): string {
    if (items.length === 0) return "No todos.";
    return items.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
  }

  const controller: TodoController = {
    getItems: () => [...items],
    replace(nextItems, source) {
      items = normalizeItems(nextItems, source);
      refresh();
      persist();
    },
    complete(step) {
      const item = items.find((t) => t.step === step);
      if (item) item.completed = true;
      refresh();
      persist();
    },
    reopen(step) {
      const item = items.find((t) => t.step === step);
      if (item) item.completed = false;
      refresh();
      persist();
    },
    clear() {
      items = [];
      refresh();
      persist();
    },
    renderPlain,
  };

  registerHudPanel({
    key: "todo",
    render(theme: HudTheme): string[] {
      if (items.length === 0) return [];
      const completed = items.filter((t) => t.completed).length;
      const arrow = expanded ? "▾" : "▸";
      const header = `${theme.c("📋", theme.YELLOW)} ${theme.c("todo", theme.YELLOW)} ${theme.c(`${completed}/${items.length}`, theme.FG)} ${theme.dim(arrow)}`;

      if (expanded) {
        return [
          header,
          ...items.map((item) =>
            item.completed
              ? `  ${theme.c("☑", theme.GREEN)} ${theme.dim(item.text)}`
              : `  ${theme.c("☐", theme.COMMENT)} ${item.text}`,
          ),
        ];
      }

      const pending = items.filter((t) => !t.completed);
      const shown = pending.slice(0, HUD_TODO_LIMIT);
      const rest = pending.length - shown.length;
      const lines = [header, ...shown.map((item) => `  ${theme.c("☐", theme.COMMENT)} ${item.text}`)];
      if (rest > 0) lines.push(`  ${theme.dim(`⋯ 还有 ${rest} 条未完成（Ctrl+T 展开）`)}`);
      return lines;
    },
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage the session todo list. Use it to create, list, complete, reopen, or clear todos. Todos are independent from /plan and are displayed in the HUD.",
    parameters: TodoToolParams,
    async execute(_toolCallId, params) {
      switch (params.action) {
        case "replace":
          controller.replace(params.items ?? [], params.source);
          break;
        case "add":
          if (params.text?.trim()) {
            items = reindex([...items, { step: items.length + 1, text: params.text.trim(), completed: false, source: params.source }]);
            refresh();
            persist();
          }
          break;
        case "complete":
          if (typeof params.step === "number") controller.complete(params.step);
          break;
        case "reopen":
          if (typeof params.step === "number") controller.reopen(params.step);
          break;
        case "clear":
          controller.clear();
          break;
        case "list":
          break;
      }
      return { content: [{ type: "text" as const, text: controller.renderPlain() }], details: { items } };
    },
  });

  pi.registerCommand("todo", {
    description: "Manage todos: /todo add TEXT | done N | reopen N | clear | list",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "list") {
        ctx.ui.notify(controller.renderPlain(), "info");
        return;
      }
      const [cmd, ...rest] = trimmed.split(/\s+/);
      if (cmd === "add") {
        const text = rest.join(" ").trim();
        if (!text) ctx.ui.notify("用法: /todo add 待办内容", "warning");
        else {
          items = reindex([...items, { step: items.length + 1, text, completed: false }]);
          refresh();
          persist();
          ctx.ui.notify(controller.renderPlain(), "info");
        }
        return;
      }
      if (cmd === "done" || cmd === "complete") {
        controller.complete(Number(rest[0]));
        ctx.ui.notify(controller.renderPlain(), "info");
        return;
      }
      if (cmd === "reopen") {
        controller.reopen(Number(rest[0]));
        ctx.ui.notify(controller.renderPlain(), "info");
        return;
      }
      if (cmd === "clear") {
        controller.clear();
        ctx.ui.notify("Todos cleared.", "info");
        return;
      }
      ctx.ui.notify("用法: /todo add TEXT | done N | reopen N | clear | list", "warning");
    },
  });

  pi.registerCommand("todos", {
    description: "Show current todo list",
    handler: async (_args, ctx) => ctx.ui.notify(controller.renderPlain(), "info"),
  });

  pi.registerShortcut(Key.ctrl("t"), {
    description: "Expand/collapse HUD todo list",
    handler: async () => {
      expanded = !expanded;
      refresh();
      persist();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entry = ctx.sessionManager
      .getEntries()
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === PERSIST_ENTRY_TYPE)
      .pop() as { data?: PersistedTodoState } | undefined;
    if (entry?.data) {
      items = entry.data.items ?? [];
      expanded = entry.data.expanded ?? false;
    }
    refresh();
  });

  return controller;
}
