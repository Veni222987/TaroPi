import type { CompactOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nextCronTime } from "./cron.ts";
import { readAutoCompactRules, unitToMs, type AutoCompactRule } from "./types.ts";

const MAX_TIMEOUT = 2_147_483_647;

export interface AutoCompactHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  compact(options?: CompactOptions): void;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager: {
    getBranch(): readonly { type?: string; customType?: string; data?: unknown }[];
    getSessionId(): string;
    getCwd(): string;
    getSessionFile(): string | undefined;
  };
}

export interface AutoCompactHooks {
  onRulesSaved?: (rules: AutoCompactRule[], ctx: AutoCompactHost) => void;
  onActivity?: (ctx: AutoCompactHost) => void;
  onCompacted?: (ctx: AutoCompactHost) => void;
}

// AutoCompactRuntime 按会话策略调度 every / idle / cron，忙时只记下待补压缩。
export class AutoCompactRuntime {
  rules: AutoCompactRule[] = [];
  private ctx?: AutoCompactHost;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private generation = 0;
  private prompts = 0;
  private streaming = false;
  private pending = false;
  private inflight = false;
  private dirty = false;
  private idleLatched = false;
  private restored = false;

  constructor(
    private readonly persist: (rules: AutoCompactRule[]) => void,
    private readonly hooks: AutoCompactHooks = {},
  ) {}

  // restore 从当前分支恢复策略并重新计时；新会话没有记录时为空。
  restore(ctx: AutoCompactHost): void {
    this.ctx = ctx;
    this.restored = true;
    this.rules = readAutoCompactRules(ctx.sessionManager.getBranch());
    this.prompts = 0;
    this.streaming = false;
    this.pending = false;
    this.inflight = false;
    this.dirty = false;
    this.idleLatched = false;
    this.reschedule();
  }

  // ensureRestored 供命令在 session_start 之前打开面板时读取当前分支。
  ensureRestored(ctx: AutoCompactHost): void {
    if (!this.restored) this.restore(ctx);
  }

  // save 写入会话记录并立即按新策略重新计时。
  save(rules: readonly AutoCompactRule[], ctx?: AutoCompactHost): void {
    this.restored = true;
    if (ctx) this.ctx = ctx;
    this.rules = rules.map((rule) => ({ ...rule }));
    this.persist(this.rules);
    this.reschedule();
    if (this.ctx) this.hooks.onRulesSaved?.(this.snapshot(), this.ctx);
  }

  snapshot(): AutoCompactRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  // stop 清掉全部计时器，用于会话切换或退出。
  stop(): void {
    this.generation += 1;
    this.restored = false;
    this.clearTimers();
    this.pending = false;
    this.inflight = false;
  }

  onActivity(ctx: AutoCompactHost): void {
    this.ctx = ctx;
    this.dirty = true;
    this.idleLatched = false;
    this.clearIdleTimers();
    this.hooks.onActivity?.(ctx);
  }

  onBusy(ctx: AutoCompactHost): void {
    this.ctx = ctx;
    this.streaming = true;
    this.dirty = true;
    this.idleLatched = false;
    this.clearIdleTimers();
  }

  onSettled(ctx: AutoCompactHost): void {
    this.ctx = ctx;
    this.streaming = false;
    this.flush();
  }

  onPrompt(active: boolean, ctx?: AutoCompactHost): void {
    if (ctx) this.ctx = ctx;
    this.prompts += active ? 1 : -1;
    if (this.prompts < 0) this.prompts = 0;
    if (!active) this.flush();
  }

  onCompactFinished(ctx?: AutoCompactHost): void {
    if (ctx) this.ctx = ctx;
    this.inflight = false;
    this.flush();
  }

  // onCompacted 在压缩成功后同步离线注册表的下一次压缩时间。
  onCompacted(ctx?: AutoCompactHost): void {
    if (ctx) this.ctx = ctx;
    if (this.ctx) this.hooks.onCompacted?.(this.ctx);
  }

  private reschedule(): void {
    this.generation += 1;
    this.clearTimers();
    const generation = this.generation;
    for (const rule of this.rules) {
      if (rule.type === "idle") continue;
      this.schedule(rule, generation);
    }
    this.armIdle();
  }

  private schedule(rule: AutoCompactRule, generation: number): void {
    if (!rule.enabled || generation !== this.generation) return;
    const delay = this.delayFor(rule);
    if (delay === undefined) return;
    const wait = Math.min(delay, MAX_TIMEOUT);
    const timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timers.delete(rule.id);
      if (wait < delay) {
        this.schedule(rule, generation);
        return;
      }
      if (rule.type === "idle") this.onIdleDue();
      else {
        this.request();
        this.schedule(rule, generation);
      }
    }, wait);
    this.timers.set(rule.id, timer);
  }

  private delayFor(rule: AutoCompactRule, now = Date.now()): number | undefined {
    if (rule.type === "cron") {
      const next = rule.cron ? nextCronTime(rule.cron, new Date(now)) : undefined;
      if (!next) return undefined;
      return Math.max(1, next.getTime() - now);
    }
    if ((rule.type !== "every" && rule.type !== "idle") || rule.value === undefined || !rule.unit) return undefined;
    return unitToMs(rule.value, rule.unit);
  }

  private onIdleDue(): void {
    this.idleLatched = true;
    this.dirty = false;
    this.clearIdleTimers();
    this.request();
  }

  private flush(): void {
    if (this.pending && !this.isBlocked()) this.request();
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleLatched || !this.dirty || this.isBlocked()) return;
    const generation = this.generation;
    for (const rule of this.rules) {
      if (rule.enabled && rule.type === "idle" && !this.timers.has(rule.id)) this.schedule(rule, generation);
    }
  }

  private request(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.isBlocked() || this.inflight) {
      this.pending = true;
      return;
    }
    this.pending = false;
    this.inflight = true;
    try {
      ctx.compact({
        onComplete: () => this.onCompactFinished(),
        onError: (error) => {
          this.inflight = false;
          if (!isSkippableCompactError(error)) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`自动压缩失败：${message}`, "warning");
          }
          this.flush();
        },
      });
    } catch (error) {
      this.inflight = false;
      if (!isSkippableCompactError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`自动压缩失败：${message}`, "warning");
      }
    }
  }

  private isBlocked(): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    try {
      return this.prompts > 0 || this.streaming || !ctx.isIdle() || ctx.hasPendingMessages();
    } catch {
      // 会话被替换或重载后旧 ctx 会失效，此时按阻塞处理，等下个事件重新拿上下文。
      return true;
    }
  }

  private clearIdleTimers(): void {
    for (const rule of this.rules) {
      if (rule.type !== "idle") continue;
      const timer = this.timers.get(rule.id);
      if (!timer) continue;
      clearTimeout(timer);
      this.timers.delete(rule.id);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

// isSkippableCompactError 识别没有新内容或用户取消，避免定时器反复报错。
export function isSkippableCompactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Already compacted") || message.includes("Nothing to compact") || message.includes("Compaction cancelled") || message.includes("cancelled") || message.includes("canceled");
}

// bindRuntimeContext 把扩展上下文收窄为调度器依赖。
export function asAutoCompactHost(ctx: ExtensionContext): AutoCompactHost {
  return ctx;
}
