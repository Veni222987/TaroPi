---
description: AI 生图 - 根据手绘草图或文字描述生成专业架构图 (PNG)
---

调用 `draw` 工具生成专业图表图片。工具会读取对应类型的风格参考（在插件 `reference/` 目录中），发送给 AI 生成 PNG 并保存到本地。

## 适用场景

- 用户提供一张手绘草图路径，想转换为专业架构图
- 用户用文字描述一个系统架构，想生成可视化图表（选 `dall-e-3`）

## 参数说明

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `input` | string | — | 手绘草图路径（`gpt-4o-image` 必填） |
| `type` | string | `architecture` | 图表类型：`architecture` / `dataflow` / `deployment` |
| `model` | string | `gpt-4o-image` | 生成模型：`gpt-4o-image`（图生图）/ `dall-e-3`（文生图） |
| `output` | string | 自动命名 | 输出 PNG 路径，默认在当前目录下以时间戳命名 |
| `prompt` | string | — | 额外的风格或内容要求，叠加在风格参考之上 |
| `size` | string | `1792x1024` | 仅 `dall-e-3` 生效：`1024x1024` / `1792x1024` / `1024x1792` |

## 前置条件

需要 `TAROPI_DRAW_KEY` 环境变量；如使用代理，设置 `TAROPI_DRAW_URL`。

## 执行要点

1. 确认用户已有草图文件或仅需文字生成
2. 根据内容选择合适的 `type`（架构图 / 数据流 / 部署拓扑）
3. 调用 `draw` 工具，工具执行完成后告知用户生成的文件路径
4. 如返回错误，检查 `TAROPI_DRAW_KEY` 是否已设置，或 `input` 文件是否存在
