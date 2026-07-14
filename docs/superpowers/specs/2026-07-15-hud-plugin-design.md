# HUD 插件设计

## 背景

参考 [pi-shannon-statusline](https://github.com/RealAlexandreAI/pi-shannon-statusline/blob/master/src/index.ts)（一个为 pi coding agent 打造的赛博朋克风格 HUD 扩展），为 `taropi-core` 移植一个同类插件，作为常驻显示的信息面板，取代/补充默认状态栏。

## 目标

- 完整还原参考实现的赛博朋克视觉风格：Monokai 配色、Matrix 数字雨背景、多行信息密度布局。
- 常驻显示：session 启动即开启，无需任何命令开关，行为与参考实现一致。
- 遵循 `taropi-core` 现有模块的组织方式与代码风格。

## 非目标

- 不做可配置项（颜色开关、数字雨开关等）——保持与参考实现一致的“无开关”体验。
- 不引入新的第三方依赖，只使用 Node.js 内置模块（`node:child_process`、`node:fs`、`node:path`、`node:os`）和已有的 `@earendil-works/pi-coding-agent` 类型。

## 架构

新增独立模块 `taropi-core/hud/index.ts`，导出 `registerHud(pi: ExtensionAPI)`，在 `taropi-core/index.ts` 中调用注册。与 `chinese`、`additionally`、`permissions` 等现有单文件模块保持同样的组织方式（一个模块一个目录，`index.ts` 承载全部逻辑，无需拆分子文件）。

代码风格上仓库统一使用 2 空格缩进（参考实现源码用的是 tab），移植时统一转换。widget key 从原来的 `shannon-hud` 改为 `taropi-hud`，避免和上游插件的 key 冲突（两者可能被同时安装）。

## 功能范围（与参考实现一致）

1. **第一行**：项目路径（fish 风格缩写）+ Git 分支/脏状态/ahead-behind/增删改统计 + 循环轮次 + 会话时长。
2. **第二行**：模型 provider/id + 上下文用量条（颜色随占比从绿→橙→粉渐变）+ token 用量。
3. **第三行**：AGENTS.md/CLAUDE.md、MCP、skills、extensions 计数（读取 `~/.pi/agent/` 下的配置文件与目录）。
4. **工具调用统计行**：白名单内（read/write/edit/bash/grep/ls/find）已完成工具调用次数 + 当前运行中的 sub-agent 数量。
5. **运行中工具**：展示最近 2 个仍在运行的工具及已耗时。
6. **Matrix 数字雨**：每行左侧叠加 6 列日文半角假名/数字/希腊字母的下落动画背景。

数据来源与事件绑定：

| 事件 | 用途 |
|------|------|
| `session_start` | 初始化会话开始时间、当前模型、cwd，清空工具/agent 记录 |
| `model_select` | 更新当前模型 provider/id |
| `turn_start` / `turn_end` | 更新轮次计数，触发重绘 |
| `tool_call` / `tool_result` | 记录工具调用开始/结束状态，用于统计和"运行中工具"展示 |
| `agent_start` / `agent_end` | 追踪 sub-agent 运行状态，用于统计运行中 agent 数 |

所有事件处理器末尾调用统一的 `refreshHud(ctx)`，内部异步构建 HUD 文本行并调用 `ctx.ui.setWidget("taropi-hud", lines, { placement: "belowEditor" })`。

Git 状态通过 `execFile` 调用 `git rev-parse` / `git status --porcelain` / `git rev-list` 获取，均有 1.5s 超时与异常兜底（拿不到就跳过该行，不阻塞 HUD 渲染）。

## 错误处理

- 所有外部读取（git 命令、文件系统读取 `~/.pi/agent/*`）均包裹 try/catch，失败时静默降级（对应信息段不显示），不影响其余 HUD 内容渲染。
- `refreshHud` 的 promise 链以 `.catch(() => {})` 收尾，避免未处理 rejection 导致进程告警。

## 文档更新

- `taropi-core/README.md`：功能表格新增一行 "🖥️ HUD 状态面板"；文件结构说明新增 `hud/` 目录条目。

## 测试与验证

纯展示型扩展，无自动化测试基础设施覆盖（`taropi-core` 目前没有测试套件）。验证方式：

- `npx tsc --noEmit`（若仓库配置了 tsconfig）或直接用 pi 加载扩展，确认无类型错误。
- 手动在 pi 交互模式下加载 `taropi-core`，确认 session 启动后编辑器下方出现多行 HUD，内容随 Git 操作、工具调用、模型切换实时刷新。
