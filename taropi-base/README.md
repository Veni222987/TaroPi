# taropi-base

TaroPi 基础扩展，提供核心能力。

## 功能

| 能力 | 说明 |
|------|------|
| 🇨🇳 中文回答 | 追加 system prompt，强制 Agent 使用简体中文 |
| 🔧 Debugger sub-agent | `/debugger` / `#debugger` — 专门定位和修复 bug |
| 🏗️ Developer sub-agent | `/developer` / `#developer` — 功能开发和代码重构 |
| 📋 Plan Mode | `/plan` / `Ctrl+Alt+P` — 只读探索模式，先出计划再执行，防止误改代码 |
| 📣 Additionally | `/additionally` — Agent 执行过程中实时插入补充说明 |

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

### Plan Mode（只读探索模式，详见 [`plan-mode/README.md`](./plan-mode/README.md)）

```bash
/plan          # 切换 plan 模式（开启后 edit/write 工具被禁用）
/todos         # 查看当前计划进度
Ctrl+Alt+P     # 快捷键切换 plan 模式
```

1. `/plan` 开启后，Agent 只能读文件、跑只读 bash 命令（`cat` / `grep` / `git status` 等），无法修改任何文件
2. 让 Agent 分析需求，在回复中输出 `Plan:` 开头的编号步骤列表
3. 选择 "Execute the plan" 后自动恢复完整工具权限并按步骤执行
4. 执行过程中 Agent 用 `[DONE:n]` 标记完成的步骤，界面顶部会显示进度 widget
5. 状态可在 `/resume` 会话恢复后保留

## 文件结构

```
taropi-base/
├── index.ts              # 入口：注册 sys-prompt、sub-agents、plan-mode
├── plan-mode/
│   ├── index.ts          # Plan Mode 核心逻辑
│   ├── utils.ts          # 计划提取 / 命令安全校验等纯函数
│   └── README.md         # 详细使用说明
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
