# recommend

推荐配置文件，选择性复制到对应位置后生效。

| 文件 | 复制到 | 说明 |
|------|--------|------|
| `AGENTS.md` | 项目根目录 `<project>/AGENTS.md`，或全局 `~/.pi/AGENTS.md` | 中文回答 + 工作原则；项目级仅对当前项目生效，全局级对所有项目生效 |
| `permissions.json` | `~/.pi/agent/permissions.json` | taropi-permissions 权限规则；插件启动时自动读取并与默认规则合并 |
| `web-search.json` | `~/.pi/web-search.json` | pi-web-access 的 `web_search` 默认走纯 API 搜索（`workflow: "none"`），跳过浏览器 curator；规避该包 `openCuratorBrowser` 中 `sendCuratorFallbackUpdate` 作用域 bug 导致的崩溃（`try`/`catch` 跨块引用变量） |

## sub-agent 模型档位（Aurum / Argentum / Cuprum）

`taropi-core` 的 `scout`/`planner`/`worker` 三个 sub-agent（`taropi-core/plain/agents/*.md`）不再直接写死具体模型 ID，而是各自声明一个档位角色名：

| Agent | 档位角色名 | 语义 |
|-------|-----------|------|
| `planner` | `Aurum` | 顶级 / 重任务（规划需要更强推理） |
| `worker` | `Argentum` | 中档 / 常规任务 |
| `scout` | `Cuprum` | 轻量 / 快速任务 |

这三个角色名需要在你自己的 `~/.pi/agent/models.json` 里，把它们绑定到具体模型。pi 的 `--model` 解析会在找不到精确 `id` 匹配时，退化用子串匹配 `name` 字段（见 `model-resolver.js` 的 `tryMatchModel`），所以只要给目标模型加上 `name: "Aurum"` 之类的字段即可，无需重新定义整个模型。

⚠️ **必须先配置好这层映射，否则 scout/planner/worker 会因为找不到匹配模型而直接报错退出。** 这不是可选优化，是运行前提。

**如果 Aurum/Argentum/Cuprum 对应的是内置模型**（比如某个 provider 已经带了 `sol`/`terra`/`luna` 这样的内置 model id），用 `modelOverrides` 追加 `name`，不用重写整个 model 定义：

```json
{
  "providers": {
    "<你的 provider 名>": {
      "modelOverrides": {
        "sol": { "name": "Aurum" },
        "terra": { "name": "Argentum" },
        "luna": { "name": "Cuprum" }
      }
    }
  }
}
```

**如果是完全自定义的模型**（还没在 `models.json` 里定义过），直接在模型定义里加 `name` 字段：

```json
{
  "providers": {
    "<你的 provider 名>": {
      "baseUrl": "...",
      "api": "...",
      "apiKey": "...",
      "models": [
        { "id": "sol", "name": "Aurum" },
        { "id": "terra", "name": "Argentum" },
        { "id": "luna", "name": "Cuprum" }
      ]
    }
  }
}
```

把对应片段**合并**进你已有的 `~/.pi/agent/models.json`（不要整体覆盖，否则会丢失你原有的 provider 配置）。`sol`/`terra`/`luna` 只是默认示例，换成你自己想用的任意模型 id 都可以，只要 `name` 字段对应上 `Aurum`/`Argentum`/`Cuprum` 即可。

## 环境变量

将以下内容追加到 `~/.bashrc`（或 `~/.zshrc`），然后重启 pi 生效：

```bash
# taropi-draw：AI 生图（必填）
export TAROPI_DRAW_KEY=sk-...

# taropi-draw：API 代理地址（可选，默认 https://api.openai.com/v1）
export TAROPI_DRAW_URL=https://your-proxy/v1
```

| 变量 | 插件 | 是否必填 | 说明 |
|------|------|----------|------|
| `TAROPI_DRAW_KEY` | taropi-draw | 必填 | API Key，用于调用 gpt-image-2 生成架构图 |
| `TAROPI_DRAW_URL` | taropi-draw | 可选 | API 代理地址；不填则直连 `https://api.openai.com/v1` |
