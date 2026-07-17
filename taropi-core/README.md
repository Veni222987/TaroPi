# taropi-core

TaroPi 整合包，一个入口加载所有核心能力。

## 功能

| 能力 | 说明 |
|------|------|
| 🎭 人物设定 | 追加 system prompt：中文回答、处事风格 |
| 🔧 Debugger sub-agent | `/debugger` / `#debugger` — 专门定位和修复 bug |
| 🏗️ Developer sub-agent | `/developer` / `#developer` — 功能开发和代码重构 |
| 📋 Plan Workflow | `/plan 任务描述` — 三阶段状态机：Aurum 制定计划、ask_user_question 循环澄清、确认后并行派发 Argentum developer；todo 独立为工具和命令 |
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

## 文件结构

```
taropi-core/
├── index.ts              # 入口：统一注册所有模块
├── character/            # 人物设定：语言习惯 / 处事风格
├── sub-agents/           # subagent 工具（single / parallel / chain 派发）
├── plan-with-todo/      # /plan 三阶段状态机（计划制定 / 澄清 / 并行实施）
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
