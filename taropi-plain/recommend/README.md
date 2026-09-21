# recommend

推荐配置文件，选择性复制到对应位置后生效。

## 给 AI 的自动同步 Prompt

把下面整段 prompt 发给 AI，即可让它根据本目录的配置映射完成**增量同步**，而不是直接覆盖你已有的 Pi 配置：

```text
你正在 TaroPi 仓库中执行推荐配置同步。请自动读取 taropi-plain/recommend 配置，并以“比较后最小改动合并”的方式写入对应目标位置。

目标：让 taropi-plain/recommend/README.md 中“文件 → 复制到”表格列出的推荐配置生效，同时保留用户已有的无关配置；不要直接 cp 或整体覆盖已存在的目标文件。

执行流程：
1. 定位仓库根目录，完整读取 taropi-plain/recommend/README.md，解析其“文件 / 复制到 / 说明”表格。表格是本次同步的唯一文件映射清单；源路径相对仓库根目录，目标路径中的 ~/ 必须展开为当前用户的 HOME。
2. 逐项读取源文件；检查目标文件是否存在，并读取其现有内容。先展示或记录每项差异，再执行写入。
3. 目标父目录不存在时才创建。源文件不存在、目标 JSON 格式非法或无法安全判断合并语义时，不要覆盖目标文件：说明原因并请求用户决定。
4. 按文件类型增量处理：
   - JSON 配置：解析源、目标为对象。目标不存在时按源内容创建；目标存在时保留仅存在于目标的字段，并用推荐配置覆盖同名的标量/对象字段。输出使用 2 空格缩进和末尾换行。
   - permissions.json：除保留目标其他字段外，推荐的 externalWriteConfirm 取源值；deny 必须按原有顺序保留目标规则，并仅追加源中尚不存在的规则。规则以完整 JSON 结构深度相等判重，不能因为相同 pattern 就删除用户携带的不同 tool 或 reason。
   - keybindings.json 与 web-search.json：保留目标中推荐文件未声明的键；推荐文件声明的键以源值为准。只有实际内容变化时才写入。
   - APPEND_SYSTEM.md 等 Markdown/纯文本追加配置：目标不存在时创建。目标已存在时，按二级标题分段比较；完全一致的段落跳过，目标没有的推荐段落才追加。若同名段落内容不同，不要静默覆盖用户内容，报告冲突并等待确认。
5. 不修改 taropi-plain/recommend/ 下的源文件，不修改 README 映射表，也不要顺带处理表格之外的配置（例如 models.json），除非用户另行明确要求。
6. 完成后逐项报告：源路径、目标路径、结果（新建 / 合并更新 / 无变化 / 需用户确认）、保留了哪些用户配置；最后提醒用户在 Pi 中执行 /reload 或重启以加载配置。

当前表格中的常见映射包括：
- taropi-plain/APPEND_SYSTEM.md → ~/.pi/agent/APPEND_SYSTEM.md
- taropi-plain/recommend/permissions.json → ~/.pi/agent/permissions.json
- taropi-plain/recommend/web-search.json → ~/.pi/agent/web-search.json
- taropi-plain/recommend/keybindings.json → ~/.pi/agent/keybindings.json
```

| 文件 | 复制到 | 说明 |
|------|--------|------|
| `taropi-plain/APPEND_SYSTEM.md` | `~/.pi/agent/APPEND_SYSTEM.md` | 追加中文表达、工作方式和工具调用规则，同时保留 Pi 默认的工具、skills 与项目上下文注入 |
| `taropi-plain/recommend/permissions.json` | `~/.pi/agent/permissions.json` | taropi-permissions 权限规则；插件启动时自动读取并与默认规则合并 |
| `taropi-plain/recommend/web-search.json` | `~/.pi/agent/web-search.json` | taropi-core 网络访问模块（`web-access/`）的默认配置：`workflow: "none"` 表示搜索直接返回结果，不额外调用模型生成摘要 |
| `taropi-plain/recommend/keybindings.json` | `~/.pi/agent/keybindings.json` | 将中断从 `Esc` 改为 `Ctrl+C`（更符合终端习惯），`Esc` 改为清空编辑器；复制后 `/reload` 生效 |

## 追加系统提示词（APPEND_SYSTEM.md）

`APPEND_SYSTEM.md` 是 Pi 的追加系统提示词机制：它在默认系统提示词后附加规则，不会像 `SYSTEM.md` 那样替换默认的工具摘要、工具 Guidelines、skills 和项目上下文。

在仓库根目录执行：

```bash
mkdir -p ~/.pi/agent
cp taropi-plain/APPEND_SYSTEM.md ~/.pi/agent/APPEND_SYSTEM.md
```

文件名必须保持全大写。复制后重启 Pi，或在 Pi 中执行 `/reload`。

## sub-agent 模型档位（Aurum / Argentum / Cuprum）

`taropi-plain` 的 `scout`/`planner`/`worker` 三个 sub-agent（`taropi-plain/agents/*.md`）各自声明一个档位角色名：

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

## 快捷键调整（keybindings.json）

默认快捷键有两个反直觉的设计：

- `Esc` → `app.interrupt`（中断），但终端用户肌肉记忆是 `Ctrl+C`
- `Ctrl+C` → `app.clear`（清空编辑器），导致按 `Ctrl+C` 想中断却清了输入

`keybindings.json` 把两者互换：

| 按键 | 默认行为 | 调整后行为 |
|------|----------|------------|
| `Ctrl+C` | 清空编辑器 (`app.clear`) | 中断 / 取消 (`app.interrupt`) |
| `Esc` | 中断 / 取消 (`app.interrupt`) | 清空编辑器 (`app.clear`) |

> **注意**：pi TUI 已拦截 raw input，`Ctrl+C` 作为中断绑定不会触发终端 SIGINT。如果后续 pi 版本对 `app.interrupt` 的默认绑定做了调整，记得对比合并，避免覆盖新功能快捷键。

安装：

```bash
cp taropi-plain/recommend/keybindings.json ~/.pi/agent/keybindings.json
```

然后在 pi 中执行 `/reload` 即可生效，无需重启 session。

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
