# taropi-draw

AI 生图插件：根据手绘草图或文字描述，调用 OpenAI API 生成专业架构图 (PNG)。

## 功能

- 注册 `draw` 工具供 AI 调用
- 注册 `/draw` slash 命令（`prompts/draw.md`）
- 内置三种图表类型的风格参考，存放于 `reference/` 目录

## 安装

```bash
pi install ./taropi-draw
```

或在 `~/.pi/agent/settings.json` 中添加：

```json
{
  "packages": ["/path/to/TaroPi/taropi-draw"]
}
```

安装后 `/reload` 或重启 pi 生效。

## 前置条件

需要 OpenAI API Key：

```bash
export TAROPI_DRAW_KEY=sk-...
# 使用代理时（可选）
export TAROPI_DRAW_URL=https://your-proxy/v1
```

## 使用方式

### 方式一：直接对话

告诉 pi 你的需求，它会自动调用 `draw` 工具：

```
把 sketch.png 转成专业架构图
帮我生成一张三层微服务部署图
```

### 方式二：`/draw` slash 命令

```
/draw sketch.png 转成系统架构图
```

## `draw` 工具参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `input` | string | — | 手绘草图路径（`gpt-4o-image` 模式必填） |
| `type` | string | `architecture` | 图表类型，见下方说明 |
| `model` | string | `gpt-4o-image` | 生成模型 |
| `output` | string | 自动命名 | 输出 PNG 路径 |
| `prompt` | string | — | 额外风格/内容要求 |
| `size` | string | `1792x1024` | 仅 `dall-e-3` 生效 |

### 图表类型 (`type`)

| 值 | 说明 | 风格参考文件 |
|----|------|-------------|
| `architecture` | 系统架构图（默认） | `reference/architecture.md` |
| `dataflow` | 数据流向图 | `reference/dataflow.md` |
| `deployment` | 部署拓扑图 | `reference/deployment.md` |

### 生成模型 (`model`)

| 值 | 说明 | 是否需要 `input` |
|----|------|-----------------|
| `gpt-4o-image` | 图生图：参考草图生成（默认） | 必填 |
| `dall-e-3` | 文生图：纯文字描述生成 | 不需要 |

## 自定义风格

`reference/` 目录中的 Markdown 文件即为各类型的 AI 生图 prompt。可直接编辑这些文件来调整默认风格，无需修改代码。

```
taropi-draw/
└── reference/
    ├── architecture.md   # 系统架构图风格
    ├── dataflow.md       # 数据流图风格
    └── deployment.md     # 部署拓扑图风格
```

额外的一次性要求可以通过 `prompt` 参数传入，会叠加在风格参考之上。
