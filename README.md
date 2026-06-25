# TaroPi

[简体中文](./README.md) | [English](./README.en.md)

个人 [pi coding agent](https://pi.dev) 扩展集合 (Monorepo)。

## 安装

```bash
# 一键安装所有扩展（含外部依赖）
pi install ./taropi-base \
  && pi install ./taropi-permissions \
  && pi install ./taropi-ssh-paste \
  && pi install ./taropi-draw \
  && pi install npm:@juicesharp/rpiv-ask-user-question
```

也可手动写入 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "/path/to/TaroPi/taropi-base",
    "/path/to/TaroPi/taropi-permissions",
    "/path/to/TaroPi/taropi-ssh-paste",
    "npm:@juicesharp/rpiv-ask-user-question"
  ]
}
```

安装后 `/reload` 或重启 pi 即可生效。

## 内置扩展

| 包 | 说明 |
|----|------|
| `taropi-base` | 核心扩展：中文回答 + debugger/developer sub-agent |
| `taropi-permissions` | 工具权限管控：读/写/bash 分级控制，敏感文件保护 |
| `taropi-ssh-paste` | SSH 图片粘贴：Ctrl+Shift+V 上传剪贴板图片到远端 |
| `taropi-draw` | AI 生图：根据手绘草图或描述生成专业架构图 (PNG) |

## 外部依赖

| 包 | 说明 |
|----|------|
| [rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | 向用户提问 |


