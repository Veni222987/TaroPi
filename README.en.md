# TaroPi

[English](./README.en.md) | [简体中文](./README.md)

A personal collection of [pi coding agent](https://pi.dev) extensions (monorepo).

## Install

```bash
pi install git:git@github.com:Veni222987/TaroPi.git
```

pi clones the repository and runs `npm install`, so all dependencies are ready.

Or add it manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:git@github.com:Veni222987/TaroPi.git"
  ]
}
```

Run `/reload` or restart pi after installation.

## Packages

| Package | Description |
|---------|-------------|
| [`taropi-core`](./taropi-core/README.md) | Core bundle: global role text, subagents, permissions, web access, user questions, and the plan workflow |
| [`taropi-hud`](./taropi-hud/README.md) | Extensible HUD host: status panel, `/hud-fresh`, and the external panel API |
| [`taropi-plain`](./taropi-plain/skills) | Plain-text resources: agents and skills |
| [`taropi-life`](./taropi-life/README.md) | Everyday skills, such as the Genshin daily check-in |
