# taropi-permissions

TAROPi 工具权限管控扩展，覆盖全部 7 个内置工具：read / grep / find / ls / write / edit / bash。

## 功能

| 工具 | 默认规则 |
|------|----------|
| 📖 read | 禁止读取敏感文件（密钥、环境变量等），其余放行 |
| 🔍 grep | 同 read，受路径 deny 规则保护 |
| 🔍 find | 同 read，受路径 deny 规则保护 |
| 📂 ls | 同 read，受路径 deny 规则保护 |
| ✏️ write | cwd 外弹窗确认；`.git/**` 禁止写入 |
| ✏️ edit | 同 write |
| ⌨️ bash | cwd 外路径弹窗确认；支持命令 deny 规则；默认禁止 `rm`（改用 `.trash`） |

### 敏感文件保护（默认）

```yaml
.bashrc / .zshrc / .bash_history / .zsh_history
.ssh/** / .aws/** / .gnupg/**
.env / .env.*
id_rsa* / id_ed25519* / id_ecdsa*
```

## 配置

配置文件位于 `~/.pi/agent/permissions.json`，首次加载时自动生成默认配置。

所有规则统一写入顶层 `deny` 数组，通过可选的 `tool` 字段区分适用范围：

```jsonc
{
  "externalWriteConfirm": true, // cwd 外的写/编辑/bash 操作弹窗确认
  "deny": [
    // 纯字符串 → 对 read/write/edit 的路径 glob 匹配（无需指定 tool）
    "**/.ssh/**",

    // 带 reason → AI 收到定制指引而非默认提示
    {
      "pattern": "**/.env",
      "reason": "禁止直接读取 .env。请使用 process.env.XXX，或让用户通过 vault 注入。"
    },

    // tool 指定只拦截写/编辑，读取仍允许
    {
      "tool": ["write", "edit"],
      "pattern": ".git/**",
      "reason": "禁止直接操作 .git 目录，请改用 git CLI（git commit、git reset 等）。"
    },

    // tool: "bash" → 命令前缀/通配符匹配
    {
      "tool": "bash",
      "pattern": "mycli dosth",
      "reason": "mycli dosth 已废弃，请改用 mycli dosth-v2 --safe。"
    },
    {
      "tool": "bash",
      "pattern": "mycli deploy *",
      "reason": "禁止 AI 自动部署，请人工执行并确认环境变量。"
    }
  ]
}
```

自定义配置只需写入需要覆盖的字段，会与默认配置深度合并（`deny` 数组整体替换）。

### tool 字段说明

| `tool` 值 | 匹配方式 | 适用场景 |
|-----------|----------|----------|
| 省略 | 路径 glob，对 read/grep/find/ls/write/edit 生效 | 保护敏感文件 |
| 单个工具名 | 路径 glob，仅对该工具生效 | 精确控制某一操作 |
| 工具名数组 | 路径 glob，对列出的工具生效 | 如写保护但允许读取 |
| `"bash"` | 命令前缀或 `*` 通配符 | 拦截特定 CLI 命令 |

**bash 命令匹配规则：**
- 无 `*`：前缀匹配，`mycli dosth` 匹配 `mycli dosth`、`mycli dosth --flag`，但不匹配 `mycli dosthing`
- 含 `*`：对完整命令做 glob 匹配，`mycli *` 匹配所有 mycli 子命令

## 文件结构

```
taropi-permissions/
├── index.ts     # 拦截 tool_call 事件，按配置放行 / 阻止 / 弹窗
└── package.json
```

## 依赖

- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)
