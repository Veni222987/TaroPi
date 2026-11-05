# TaroPi

[English](./README.en.md) | [简体中文](./README.md)

A personal collection of [pi coding agent](https://pi.dev) extensions (monorepo).

## Architecture

```mermaid
flowchart LR
  PI[pi coding agent]
  CORE[taropi-core\ncore extension]
  PLAIN[taropi-plain\nagents and skills]

  PI --> CORE
  PI --> PLAIN
  CORE -.loads bundled agent definitions.-> PLAIN
```

## Install

```bash
pi install ./
```

Or manually add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/TaroPi"
  ]
}
```

Run `/reload` or restart pi after installation.

## Bundled Extensions

| Package | Description |
|---------|-------------|
| `taropi-core` | Core: subagent tools, permission control, Chinese response, web access, etc. |
| `taropi-plain` | Plain-text resources: subagent definitions and skills |


