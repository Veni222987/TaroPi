# taropi-core

TaroPi 整合包，一个入口加载所有核心能力。

## 功能

| 能力 | 说明 |
|------|------|
| 📝 追加系统提示词 | `../taropi-plain/APPEND_SYSTEM.md`：中文表达、工作方式与工具调用规则；按 `../taropi-plain/recommend/README.md` 复制后由 Pi 追加到默认提示词 |
| 🔧 Debugger sub-agent | `/debugger` / `#debugger` — 专门定位和修复 bug |
| 🏗️ Developer sub-agent | `/developer` / `#developer` — 功能开发和代码重构 |
| 📋 Plan Workflow | `/plan 任务描述` — 三阶段状态机（`plan/`）：调研并在不确定时反复澄清 → TUI 写入计划文件并展示地址 → 按确认计划实施 |
| 🔒 权限管控 | 敏感文件保护、cwd 外写入二次确认、禁止 `rm` 命令 |
| 🌐 网络访问 | 网页搜索（Brave/Exa/OpenAI）、URL 正文抓取、GitHub 仓库/文件、图片、本地 PDF 文本提取 |
| 🖥️ HUD 状态面板 | 常驻显示 Git 状态、模型/上下文用量、工具调用统计等信息；外部包可通过 `taropi-hud` 注册带刷新能力的文本子版块，`/hud-fresh` 并发刷新全部子版块 |

## 开发校验

```bash
make test
```

`make test` 使用 Vitest 运行 `taropi-core` 单元测试，并在 `coverage/` 生成 text、HTML 与 LCOV 覆盖率报告。

## 安装

在 `~/.pi/agent/settings.json` 的 `packages` 里加一行：

```json
{
  "packages": [
    "/path/to/TaroPi"
  ]
}
```

## 配置

### 权限管控（可选）

默认配置开箱即用。如需自定义，编辑 `~/.pi/agent/permissions.json`：

```json
{
  "externalWriteConfirm": true,
  "deny": [
    "**/.env",
    "**/.ssh/**",
    { "tool": "bash", "pattern": "rm *", "reason": "请用 mv <file> .trash/ 替代" }
  ]
}
```

首次启动时会自动生成该文件并写入默认规则。

### 网络访问（`web-access/`）

提供四个工具：`web_search`、`fetch_content`、`get_search_content`、`source_check`。搜索源覆盖 Brave、Exa、OpenAI；抓取覆盖网页正文、GitHub 仓库/文件、图片和本地 PDF 文本解析。

**无需任何 API key 即可使用**：Exa 在未配置 Key 时通过本机 [`mcporter`](https://github.com/badlogic/mcporter) 调用其托管 MCP 实现零配置搜索，开箱即用（需要 `mcporter` 在 PATH 中）。

如需接入其他搜索提供商，编辑 `~/.pi/agent/web-search.json`：

```json
{
  "provider": "brave",
  "workflow": "none"
}
```

#### 搜索提供商

| 提供商 | 配置字段 | 环境变量 | 申请链接 |
|--------|---------|---------|---------|
| Brave Search | `braveApiKey` | `BRAVE_API_KEY` | https://brave.com/search/api/ |
| Exa | `exaApiKey` | `EXA_API_KEY` | https://exa.ai |
| OpenAI | `openaiApiKey`（或 Pi 的 OpenAI/Codex 登录） | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |

`provider` 可选值：`auto`（默认，Exa 优先，Codex 会话下 OpenAI 优先）/ `brave` / `exa` / `openai` / 数组（同时查询多个来源）

`workflow` 可选值：`none`（默认）/ `auto-summary`（使用当前 Pi 模型生成摘要）

#### 完整示例配置（`~/.pi/agent/web-search.json`）

```json
{
  "provider": "auto",
  "workflow": "none",

  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "openaiApiKey": "sk-...",

  "summaryModel": "anthropic/claude-haiku-4-5",

  "fetch": {
    "defaultMode": "readable",
    "allowedModes": ["readable", "raw", "answer"]
  },

  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "clonePath": "/tmp/pi-taropi-github-repos"
  },

  "pdf": {
    "enabled": true,
    "maxSizeMB": 20,
    "maxPages": 100
  },

  "authFetch": {
    "work": { "hosts": ["intranet.example.com"], "cache": "session" }
  },
  "allowBrowserCookies": false,

  "ssrf": {
    "allowRanges": [],
    "trustEnvProxy": false
  }
}
```

`authFetch` 登录态抓取默认关闭：仅在 `allowBrowserCookies: true` 且显式声明 host 白名单的 profile 时，`fetch_content` 的 `auth` 参数才能读取本机浏览器 Cookie，且不允许跨源重定向。

## Subagent 面板快捷键

子 Agent 运行时会显示紧凑面板。导航列表的第一个项目固定是 **Main**，表示主对话和编辑器，不是一个子 Agent：选中 Main 后按 `Enter` 会回到主编辑器；选中子 Agent 后按 `Enter` 打开其全屏实时详情。

| 场景 | 按键 | 操作 |
|------|------|------|
| 面板激活 | `Ctrl+[` | 选择上一个项目（仅 Kitty / CSI-u 等能区分该按键的终端） |
| 面板激活 | `Ctrl+]` | 选择下一个项目；面板未激活时保留 Pi 编辑器原有的跳转行为 |
| 面板激活 | `Ctrl+Shift+[` | 选择上一个项目的兼容回退按键 |
| 面板激活 | `Ctrl+Shift+]` | 选择下一个项目的兼容回退按键 |
| 面板激活 | `Enter` | Main 返回主编辑器；子 Agent 打开全屏详情 |
| 面板激活 | `Ctrl+Shift+\` | 关闭子 Agent 面板 |
| 全屏详情 | `↑` / `↓`、`PageUp` / `PageDown` | 滚动完整动态和工具调用 |
| 全屏详情 | `Home` / `End` | 跳到开头；恢复到底部并自动跟随新消息 |
| 全屏详情 | `F` | 切换自动跟随最新动态 |
| 全屏详情 | `Escape` | 返回紧凑面板 |

全屏详情在位于底部时会自动跟随新消息；手动向上滚动时会暂停跟随，避免阅读中的内容被刷新打断。

### 终端限制

传统终端通常会把 `Ctrl+[` 编码成与 `Escape` 相同的字节，因此 TaroPi **不会**把原始 `Ctrl+[` 当作全局快捷键拦截，否则会破坏 Escape 的取消/返回行为。Kitty keyboard protocol、CSI-u（例如正确配置的 tmux）或 xterm `modifyOtherKeys` 能保留修饰键信息，此时可直接使用 `Ctrl+[`；无法区分时请使用 `Ctrl+Shift+[` 和 `Ctrl+Shift+]` 回退。`Ctrl+]` 同样只会在面板激活时被消费，日常编辑不受影响。

## 文件结构

```
TaroPi/
├── taropi-core/
│   ├── index.ts          # 入口：统一注册所有模块
│   ├── sub-agents/       # subagent 工具（single / parallel / chain 派发）
│   ├── plan/             # /plan 三阶段状态机（调研澄清 / TUI 确认与计划文件 / 主 Agent 实施）
│   ├── permissions/      # 权限管控
│   ├── web-access/       # 网络访问：web_search / fetch_content / get_search_content / source_check
│   │   └── searchimpl/   # 搜索来源适配器（Brave / Exa / OpenAI），新增来源在此追加实现
│   ├── hud-adapt.ts      # core 内部模块接入 HUD 的统一适配层
│   └── ...
├── taropi-hud/            # 可独立安装的 HUD 宿主、协议与外部开发 API
├── taropi-plain/         # 纯文本资源：APPEND_SYSTEM / agents / skills / recommend
    ├── APPEND_SYSTEM.md  # 中文表达、工作方式与工具调用规则；按 recommend 配置到 ~/.pi/agent/ 后由 Pi 加载
    ├── agents/           # subagent 定义（scout / planner / developer / reviewer），会话启动时自动同步到 ~/.pi/agent/agents/
    ├── recommend/        # 推荐配置及其安装说明
    └── skills/           # 可发现的 skill（SKILL.md）
```

### 新增 skill

新建 `../taropi-plain/skills/name/SKILL.md`（frontmatter 含 name / description），无需改 package.json，/reload 即可生效。

## 依赖

- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)
- `@juicesharp/rpiv-ask-user-question` (bundled，随 `npm install` 自动安装)
- `@mozilla/readability`、`linkedom`、`turndown`、`undici`、`unpdf` (bundled，`web-access/` 网页正文提取、代理转发与本地 PDF 解析所需，随 `npm install` 自动安装)
