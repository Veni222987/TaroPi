# taropi-base

TaroPi 基础扩展，提供核心能力。

## 功能

| 能力 | 说明 |
|------|------|
| 🇨🇳 中文回答 | 追加 system prompt，强制 Agent 使用简体中文 |
| 🔧 Debugger sub-agent | `/debugger` / `#debugger` — 专门定位和修复 bug |
| 🏗️ Developer sub-agent | `/developer` / `#developer` — 功能开发和代码重构 |

## 使用方式

### 命令

```bash
/debugger 修复 handler 里未捕获的异常
/developer 新增用户导出接口
```

### 快捷键

在输入框输入 `#debugger` 或 `#developer` 加任务描述即可触发。

### Tool

Agent 可调用 `delegate_to_debugger` / `delegate_to_developer` tool 启动并行 sub-agent。

## 文件结构

```
taropi-base/
├── index.ts              # 入口：注册 sys-prompt 和 sub-agents
├── sys-prompt/
│   ├── register.ts       # 注入中文回答 prompt
│   └── append_system.md  # 中文回答 + 工作原则 prompt
├── sub-agents/
│   ├── register.ts       # 注册 # 前缀、/command、tool
│   ├── runner.ts         # sub-agent 执行器
│   ├── debugger.ts       # Debugger 配置
│   └── developer.ts      # Developer 配置
└── prompts/              # 可发现的 prompt 模板
```

## 依赖

- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)
