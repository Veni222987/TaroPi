# TaroPi

[简体中文](./README.md) | [English](./README.en.md)

个人 [pi coding agent](https://pi.dev) 扩展集合 (Monorepo)。

## 安装

```bash
pi install git:git@github.com:Veni222987/TaroPi.git
```

pi 会自动 clone 仓库并运行 `npm install`，所有依赖就位。

也可手动写入 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "git:git@github.com:Veni222987/TaroPi.git"
  ]
}
```

安装后 `/reload` 或重启 pi 即可生效。

## 分包介绍

| 包 | 说明 |
|----|------|
| [`taropi-core`](./taropi-core/README.md) | 核心整合包：全局角色文本、subagent、权限管控、网络访问、向用户提问、plan 工作流等 |
| [`taropi-hud`](./taropi-hud/README.md) | 可扩展 HUD 宿主：基础状态面板、`/hud-fresh` 和外部子版块开发接口 |
| [`taropi-plain`](./taropi-plain/skills) | 纯文本资源目录：agents 与 skills |
| [`taropi-life`](./taropi-life/README.md) | 生活向 skill，例如原神每日签到 |
