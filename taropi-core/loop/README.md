# /loop —— crontab 驱动的定时循环

参考 Claude Code `/loop` 的思路（到点自重新调度、任务内容和调度节奏解耦），但落地方式换成本地系统自带的 `crontab`：pi 没有 Claude Code 那种云端调度器托底，crontab 正好能当这个外部调度基础设施用。

## 核心思路

- 每一轮都是 crontab 到点拉起的一个**全新** `pi -p --no-session` 进程/session，跟你当前正在用的交互式 pi 会话完全隔离，关掉当前终端也不影响 loop 继续跑。
- `/loop create` 时（在当前交互式会话里）解析一次 agent 定义（复用 `sub-agents/agents.ts` 的 `discoverAgents`），把 `--model`/`--tools`/`--append-system-prompt` 这些固定参数烤进 crontab 命令行。
- 真正"随时可编辑"的只有任务文本 `task.md`：crontab 命令里用 `"$(cat task.md)"` 在每次触发时现读现填，你随时用外部编辑器或 `/loop edit` 改，下一轮自动生效，不需要重新 create/start。

## 落盘布局

```
.pi/taropi/loop/<name>/
├── config.json         # 静态定义：agent / model / tools / interval / cwd
├── task.md             # 任务文本，随时编辑
├── system-prompt.md    # 创建时从 agent 定义复制的一份快照
└── runs/
    └── <timestamp>.log # 每轮一个独立日志文件，文件数量即迭代次数
```

## 命令

| 命令 | 作用 |
|------|------|
| `/loop create <name> <agent> --interval 30m [--model Au]` | 解析 agent 定义、写 config/task/system-prompt，**不会**立即装 crontab |
| `/loop start <name>` | 把该 loop 装进 crontab（真正开始定时触发） |
| `/loop stop <name>` | 从 crontab 移除这一条，config/task 文件不动，随时能 `/loop start` 重新开始 |
| `/loop list` | 列出所有 loop 及运行状态、轮数 |
| `/loop status <name>` | 看某个 loop 的详细状态（是否在跑、cron 表达式、最近一次运行） |
| `/loop edit <name>` | 用内置多行编辑器改 `task.md`（文件本身随时可以直接用外部编辑器改） |
| `/loop remove <name>` | 卸 crontab + 删除该 loop 的所有文件（会二次确认） |

`--interval` 支持 `30m`（1-59 分钟）、`2h`（1-23 小时），或原始 5 段 cron 表达式（如需要"每天一次"这类更长周期）。

## 注意事项

- 依赖本机安装了 `crontab`（macOS/Linux 默认自带；纯容器环境可能没有）。
- crontab 条目带 `# TaroPi-loop:<name>` 标记，`start/stop/remove` 只增删自己这两行，不会动你原有的其它 cron 任务。
- crontab 的执行环境 PATH 很有限，`buildLoopCommand` 会尽量解析出 pi 可执行文件的绝对路径写进命令行，避免裸 `pi` 在 cron 环境里找不到。
- 每轮都是独立 session，彼此之间没有对话历史延续；如果任务需要"记住上次做到哪了"，请让任务文本本身描述清楚状态，或让 agent 在 `task.md` 同目录之外自己维护进度文件。
