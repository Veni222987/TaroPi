# recommend

推荐配置文件，选择性复制到对应位置后生效。

| 文件 | 复制到 | 说明 |
|------|--------|------|
| `AGENTS.md` | 项目根目录 `<project>/AGENTS.md`，或全局 `~/.pi/AGENTS.md` | 中文回答 + 工作原则；项目级仅对当前项目生效，全局级对所有项目生效 |
| `permissions.json` | `~/.pi/agent/permissions.json` | taropi-permissions 权限规则；插件启动时自动读取并与默认规则合并 |

## 环境变量

将以下内容追加到 `~/.bashrc`（或 `~/.zshrc`），然后重启 pi 生效：

```bash
# taropi-draw：AI 生图（必填）
export OPENAI_API_KEY=sk-...

# taropi-draw：API 代理地址（可选，默认 https://api.openai.com/v1）
export OPENAI_BASE_URL=https://your-proxy/v1
```

| 变量 | 插件 | 是否必填 | 说明 |
|------|------|----------|------|
| `OPENAI_API_KEY` | taropi-draw | 必填 | OpenAI API Key，用于调用 gpt-image-2 生成架构图 |
| `OPENAI_BASE_URL` | taropi-draw | 可选 | API 代理地址；不填则直连 `https://api.openai.com/v1` |
