# taropi-permissions

TAROPi 工具权限管控扩展，对 read / write / edit / bash 工具进行分级控制。

## 功能

| 工具 | 默认规则 |
|------|----------|
| 📖 read | 默认全部允许，禁止读取敏感文件（密钥、环境变量等） |
| ✏️ write | cwd 内允许，cwd 外弹窗确认，`.git/**` 禁止 |
| ✏️ edit | 同 write |
| ⌨️ bash | cwd 内允许，涉及外部路径弹窗确认 |

### 敏感文件保护（默认）

```yaml
.bashrc / .zshrc / .bash_history / .zsh_history
.ssh/** / .aws/** / .gnupg/**
.env / .env.*
id_rsa* / id_ed25519* / id_ecdsa*
```

## 配置

配置文件位于 `~/.pi/agent/permissions.json`，首次加载时自动生成默认配置。

```jsonc
{
  "read": {
    "allowAll": true,          // 默认允许所有读取
    "deny": ["**/.ssh/**"]     // 禁止的 glob 列表
  },
  "write": {
    "allowCwd": true,          // cwd 内默认允许
    "externalConfirm": true,   // cwd 外弹窗确认
    "cwdDeny": [".git/**"]     // cwd 内也禁止的路径
  },
  "bash": {
    "allowCwd": true,
    "externalConfirm": true
  }
}
```

自定义配置只需写入需要覆盖的字段，会与默认配置深度合并。

## 文件结构

```
taropi-permissions/
├── index.ts     # 拦截 tool_call 事件，按配置放行 / 阻止 / 弹窗
└── package.json
```

## 依赖

- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)
