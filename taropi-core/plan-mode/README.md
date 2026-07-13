# Plan Mode

只读探索模式：先让 Agent 分析并输出计划，确认无误后再放开权限执行，避免代码被误改。

## 功能

- **禁用写工具**：开启后内置的 `edit` / `write` 工具被禁用，其余已激活工具保持可用
- **bash 白名单**：只允许只读命令（`cat` / `grep` / `git status` 等），阻断 `rm` / `git commit` / `npm install` 等有副作用的命令
- **计划提取**：自动从回复中的 `Plan:` 段落解析出编号步骤
- **进度追踪**：执行阶段界面顶部显示 `☑/☐` 进度 widget
- **`[DONE:n]` 标记**：Agent 完成某步骤后在回复中打上标记，自动勾选对应 todo
- **会话持久化**：状态会保存到 session，`/resume` 恢复会话后计划和进度不丢失

## 命令 / 快捷键

| 触发方式 | 作用 |
|---|---|
| `/plan` | 切换 plan 模式（开 / 关） |
| `Ctrl+Alt+P` | 快捷键切换 plan 模式 |
| `/todos` | 查看当前计划的完成进度 |
| `--plan` 启动参数 | 以 plan 模式启动 pi |

## 使用流程

1. 输入 `/plan` 开启只读探索模式（或用 `pi --plan` 启动）
2. 正常提需求，例如："分析一下登录模块的鉴权逻辑，给出重构方案"
3. Agent 只能读文件、跑只读 bash 命令，不能改代码；回复末尾会输出：

   ```
   Plan:
   1. 提取 auth.ts 中的 token 校验逻辑
   2. 抽出独立的 AuthGuard 中间件
   3. 补充单元测试
   ```

4. 界面会弹出选择框：
   - **Execute the plan** — 恢复完整工具权限，按步骤自动执行，每完成一步打 `[DONE:n]` 标记，进度实时显示
   - **Stay in plan mode** — 继续留在只读模式，可以追问或换个方向分析
   - **Refine the plan** — 打开编辑器，补充/修改计划要求后重新生成
5. 执行过程中随时 `/todos` 查看进度；全部完成后会自动提示 "Plan Complete! ✓" 并退出执行模式

## 只读命令白名单（plan 模式下允许）

`cat` `head` `tail` `less` `more` `grep` `find` `rg` `fd` `ls` `pwd` `tree`
`git status/log/diff/show/branch` `npm list/view/outdated` `yarn info`
`uname` `whoami` `date` `uptime` `ps` `df` `du` `jq` `awk` 等

## 禁止命令（plan 模式下会被拦截）

`rm` `mv` `cp` `mkdir` `touch` `chmod` `chown`
`git add/commit/push/reset/checkout/merge/rebase`
`npm install/uninstall` `yarn add/remove` `pip install`
`sudo` `kill` `reboot` `vim/nano/code` 等编辑器

## 文件结构

```
plan-mode/
├── index.ts   # 主逻辑：命令/快捷键注册、工具权限切换、计划提取与执行流程
└── utils.ts   # 纯函数：命令安全校验、计划文本解析、[DONE:n] 标记提取
```
