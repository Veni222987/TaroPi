# taropi-ssh-paste

SSH 图片粘贴扩展，`Ctrl+Shift+V` 一键上传剪贴板图片到 SSH 远端。

## 使用方式

1. 复制一张图片到剪贴板（截图或复制图片文件）
2. 按下 `Ctrl+Shift+V`
3. 扩展自动检测活跃的 SSH 连接，上传图片到远端的 `.pi/images/` 目录
4. 图片路径自动写入 TUI 输入框

多个 SSH 连接时会弹出选择框让你选择目标。

## 平台支持

| 平台 | 剪贴板读取方式 |
|------|---------------|
| 🍎 macOS | AppleScript (`osascript`) |
| 🐧 Linux | `xclip` / `wl-paste` |
| 🪟 Windows | PowerShell `System.Windows.Forms.Clipboard` |

传输依赖 `scp`，需确保远端 SSH server 支持。

## 文件结构

```
taropi-ssh-paste/
├── index.ts     # 剪贴板读取 + SSH 检测 + 上传 + 快捷键注册
└── package.json
```

## 依赖

- macOS: 系统自带 `osascript`、`scp`
- Linux: `xclip` 或 `wl-paste`、`scp`
- Windows: PowerShell、`scp`
- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)
