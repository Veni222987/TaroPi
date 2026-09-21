# taropi-hud

`taropi-hud` 提供常驻 HUD 宿主、基础状态看板和面向 Pi 扩展的子版块 API。`taropi-core` 默认集成该包；也可以将本包单独添加至 Pi 的 `packages`。

## 开发子版块

外部扩展在入口中创建客户端并注册同时具有 `refresh`、`render` 的版块。HUD 在版块注册且会话可用后执行一次首次刷新；之后的自动刷新由外部扩展自行调度。

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHudClient } from "taropi-hud/api";
import type { HudPanelState } from "taropi-hud/protocol";
import type { HudTheme } from "taropi-hud/theme";

export default function registerBalanceHud(pi: ExtensionAPI): void {
  const hud = createHudClient(pi);
  const balance = hud.register({
    key: "example-balance",
    timeoutMs: 5_000,
    async refresh({ signal }) {
      const response = await fetch("https://example.invalid/balance", { signal });
      return (await response.json()) as { amount: string };
    },
    render(state: HudPanelState<{ amount: string }>, theme: HudTheme): string[] {
      if (!state.value) return [theme.dim(state.status === "error" ? `余额不可用：${state.error}` : "余额加载中")];
      return [`${theme.c("●", theme.GREEN)} 余额 ${theme.c(state.value.amount, theme.FG)}`];
    },
  });

  pi.on("turn_end", async () => {
    try {
      await balance.refresh();
    } catch {
      // HUD 保留最近一次成功内容并展示异常状态。
    }
  });
}
```

- `refresh` 接收会话上下文、刷新原因和 `AbortSignal`，必须返回可渲染的数据快照。
- `render` 必须同步返回 ANSI 文本行；空数组表示暂不显示。
- `timeoutMs` 默认为 10 秒。失败时 HUD 保留上一次成功数据；首次失败显示错误状态。
- `handle.refresh()` 只刷新该版块；`hud.refreshAll()` 刷新所有版块；`handle.render()` 和 `hud.render()` 只重绘，不拉取数据。
- `/hud-fresh` 总是并发刷新当前全部版块，等待完成或超时后统一重绘并汇总失败项目。
- 调用 `handle.unregister()` 可移除版块。会话切换和 `/reload` 后不应继续持有旧会话上下文。
