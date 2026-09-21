import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HudPanelProvider, HudPanelState, HudRefreshReason } from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface RegisteredHudPanel {
  provider: HudPanelProvider;
  state: HudPanelState;
  tail: Promise<void>;
}

/** HudPanelRegistry 管理 HUD 子版块的注册顺序、快照与串行刷新队列。 */
export class HudPanelRegistry {
  private readonly panels = new Map<string, RegisteredHudPanel>();
  private generation = 0;

  register(provider: HudPanelProvider): RegisteredHudPanel {
    const current = this.panels.get(provider.key);
    if (current) {
      current.provider = provider;
      return current;
    }
    const panel: RegisteredHudPanel = { provider, state: { status: "idle", value: undefined }, tail: Promise.resolve() };
    this.panels.set(provider.key, panel);
    return panel;
  }

  unregister(key: string, provider: HudPanelProvider): void {
    if (this.panels.get(key)?.provider === provider) this.panels.delete(key);
  }

  get(key?: string): RegisteredHudPanel[] {
    if (key === undefined) return [...this.panels.values()];
    const panel = this.panels.get(key);
    return panel ? [panel] : [];
  }

  invalidate(): void {
    this.generation++;
  }

  refresh(key: string | undefined, ctx: ExtensionContext, reason: HudRefreshReason): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(this.get(key).map((panel) => this.enqueue(panel, ctx, reason)));
  }

  private enqueue(panel: RegisteredHudPanel, ctx: ExtensionContext, reason: HudRefreshReason): Promise<void> {
    const generation = this.generation;
    const run = async (): Promise<void> => {
      if (generation !== this.generation) return;
      const controller = new AbortController();
      panel.state = { ...panel.state, status: "refreshing", error: undefined };
      const timeout = setTimeout(() => controller.abort(), panel.provider.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const value = await Promise.race([
          Promise.resolve(panel.provider.refresh({ ctx, reason, signal: controller.signal })),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error(`刷新超时（${panel.provider.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`)), { once: true });
          }),
        ]);
        if (generation === this.generation) panel.state = { value, status: "ready", updatedAt: Date.now() };
      } catch (error) {
        if (generation === this.generation) {
          panel.state = {
            ...panel.state,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    const queued = panel.tail.then(run, run);
    panel.tail = queued.catch(() => undefined);
    return queued;
  }
}
