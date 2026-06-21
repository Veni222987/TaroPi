# TaroPi

[简体中文](./README.md) | [English](./README.en.md)

个人 [pi coding agent](https://pi.dev) 扩展集合 (Monorepo)。

## 安装

```bash
# 一键安装所有扩展（含外部依赖）
pi install ./taropi-base \
  && pi install ./taropi-permissions \
  && pi install npm:@juicesharp/rpiv-ask-user-question
```

也可手动写入 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "/path/to/TaroPi/taropi-base",
    "/path/to/TaroPi/taropi-permissions",
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

## 外部依赖

| 包 | 说明 |
|----|------|
| [rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | 向用户提问 |

---

目录规范与新增插件流程见 [`.agents/AGENT.md`](./.agents/AGENT.md)。
