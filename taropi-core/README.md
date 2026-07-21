# taropi-core

TaroPi 整合包，一个入口加载所有核心能力。

## 功能

| 能力 | 说明 |
|------|------|
| 🎭 人物设定 | 追加 system prompt：中文回答、处事风格 |
| 🔧 Debugger sub-agent | `/debugger` / `#debugger` — 专门定位和修复 bug |
| 🏗️ Developer sub-agent | `/developer` / `#developer` — 功能开发和代码重构 |
| 📋 Plan Workflow | `/plan 任务描述` — 三阶段状态机（`plan/`）：Aurum 制定计划、选择框（开始实现/补充内容）循环澄清、确认后并行派发 Argentum developer；todo 独立为工具和命令 |
| 🔁 Loop | `/loop create\|start\|stop\|list\|status\|edit\|remove`（`loop/`）：crontab 驱动的定时循环，复用 agent 定义按固定间隔跑一个任务，每轮独立进程/独立 session，任务文本随时可编辑 |
| 📣 Additionally | `/additionally` — 执行过程中实时插入补充说明 |
| 🔒 权限管控 | 敏感文件保护、cwd 外写入二次确认、禁止 `rm` 命令 |
| 🌐 网络访问 | 网页搜索、URL 抓取、GitHub 克隆、PDF 提取、YouTube 理解 |
| 🖥️ HUD 状态面板 | 常驻显示 Git 状态、模型/上下文用量、工具调用统计等信息的赛博朋克风格 HUD |

## 安装

在 `~/.pi/agent/settings.json` 的 `packages` 里加一行：

```json
{
  "packages": [
    "/path/to/taropi-core"
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

### 网络访问（[pi-web-access](https://github.com/nicobailon/pi-web-access)）

**无需任何 API key 即可使用**：Exa MCP 提供零配置搜索，开箱即用。

如需接入其他搜索提供商，编辑 `~/.pi/web-search.json`：

```json
{
  "provider": "brave",
  "workflow": "summary-review"
}
```

#### 搜索提供商

| 提供商 | 配置字段 | 环境变量 | 申请链接 |
|--------|---------|---------|---------|
| Brave Search | `braveApiKey` | `BRAVE_API_KEY` | https://brave.com/search/api/ |
| Exa | `exaApiKey` | `EXA_API_KEY` | https://exa.ai |
| Tavily | `tavilyApiKey` | `TAVILY_API_KEY` | https://tavily.com |
| Perplexity | `perplexityApiKey` | `PERPLEXITY_API_KEY` | https://www.perplexity.ai/settings/api |
| OpenAI | `openaiApiKey` | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| Google Gemini | `geminiApiKey` | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| Parallel | `parallelApiKey` | `PARALLEL_API_KEY` | https://parallel.ai |

#### 完整示例配置（`~/.pi/web-search.json`）

```json
{
  "provider": "brave",
  "workflow": "summary-review",

  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "tavilyApiKey": "tvly-...",
  "perplexityApiKey": "pplx-...",
  "openaiApiKey": "sk-...",
  "geminiApiKey": "AIza...",

  "searchModel": "gemini-2.5-flash",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "curatorTimeoutSeconds": 20,

  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "clonePath": "/tmp/pi-github-repos"
  },

  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-2.5-flash"
  },

  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

`provider` 可选值：`brave` / `exa` / `tavily` / `perplexity` / `openai` / `gemini`

`workflow` 可选值：`summary-review`（默认，人工审阅）/ `auto-summary`（自动摘要）/ `none`

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
taropi-core/
├── index.ts              # 入口：统一注册所有模块
├── character/            # 人物设定：语言习惯 / 处事风格
├── sub-agents/           # subagent 工具（single / parallel / chain 派发）
├── plan/                 # /plan 三阶段状态机（计划制定 / 澄清 / 并行实施）
├── loop/                 # /loop crontab 驱动的定时循环（复用 agent 定义，独立进程/独立 session）
├── todo/                # 独立 todo 工具、/todo 命令、HUD todo 面板
├── additionally/         # /additionally 命令
├── permissions/          # 权限管控
├── hud/                  # 常驻 HUD 状态面板
└── plain/                # 纯文本资源：agents / skills
    ├── agents/           # subagent 定义（scout / planner / developer / reviewer），会话启动时自动同步到 ~/.pi/agent/agents/
    └── skills/           # 可发现的 skill（SKILL.md）
```

### 新增 skill

新建 `plain/skills/name/SKILL.md`（frontmatter 含 name / description），无需改 package.json，/reload 即可生效。

## 依赖

- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)
- `pi-web-access` (bundled，随 `npm install` 自动安装)
- `@juicesharp/rpiv-ask-user-question` (bundled，随 `npm install` 自动安装)
