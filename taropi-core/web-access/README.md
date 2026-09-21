# web-access

TaroPi 的自研网络访问模块，替代第三方 `pi-web-access`，提供四个工具：

| 工具 | 说明 |
|------|------|
| `web_search` | 批量执行搜索查询，自动选源或显式指定 provider |
| `fetch_content` | 抓取一个或多个 URL：网页正文、GitHub 仓库/文件、图片、本地 PDF 文本 |
| `get_search_content` | 按 `responseId` 检索之前工具存储的内容，支持分页与文本查找 |
| `source_check` | 为一个断言收集结构化证据（来源 + 引用片段），供人工核验 |

## 目录结构

```
web-access/
├── index.ts        # 注册四个工具
├── config.ts        # web-search.json 配置加载与校验
├── credential.ts     # 密钥解析（字面量 / $ENV_VAR / 环境变量），不支持 !command
├── types.ts          # 公共类型
├── search/           # 搜索调度：provider 选择、自动回退、并发聚合
├── searchimpl/        # 搜索来源适配器：Brave、Exa、OpenAI；新增来源在此追加实现
├── network/           # SSRF 防护、代理转发、统一请求封装
├── fetch/              # 网页/GitHub/PDF 抓取与响应大小限制
├── auth/                # authFetch 登录态抓取与本机浏览器 Cookie 读取
├── content/              # 结果存储（内存 + 磁盘缓存）与文本查找
├── model/                  # 网页问答（answer 模式）与搜索摘要（auto-summary）
├── research/                # source_check 的证据整理
└── tools/                     # 四个工具的参数 schema 与执行逻辑
```

## 搜索来源

支持 **Brave**、**Exa**、**OpenAI** 三个来源：

- **Brave**：REST API，需要 `braveApiKey` 或 `BRAVE_API_KEY`。
- **Exa**：有 `exaApiKey`/`EXA_API_KEY` 时走官方 API；无 Key 时通过本机 [`mcporter`](https://github.com/badlogic/mcporter) 调用 Exa 托管 MCP（`https://mcp.exa.ai/mcp`），零配置可用。
- **OpenAI**：仅实现 Responses API 的托管 `web_search` 工具（不支持 `alpha/search`）。认证优先使用 Pi 的 `openai-codex`/`openai` 登录凭据，其次 `openaiApiKey`/`OPENAI_API_KEY`；支持自定义网关地址（`openaiResponsesUrl`）和模型（`openaiSearchModel`）。

默认自动选源顺序：Exa → Brave → OpenAI；当前会话为 OpenAI Codex 模型时优先 OpenAI。可通过 `web-search.json` 的 `searchProviderOrder` 覆盖整体顺序；显式指定单个 provider 时不会静默切换到其他来源。

新增来源：在 `searchimpl/` 下实现 `SearchProvider` 接口（`isAvailable` + `search`），并在 `searchimpl/index.ts` 的 provider 列表中追加即可。

## 配置（`~/.pi/agent/web-search.json`）

参见 `taropi-core/README.md` 的“网络访问”章节，包含搜索来源、`fetch` 模式、`githubClone`、`pdf`、`authFetch`、`ssrf` 等字段的完整示例。

## 安全边界

- 所有用户提供的抓取目标经过 SSRF 校验：拒绝内网/私有地址、`localhost`，重定向逐跳重新校验。
- `authFetch` 登录态抓取默认关闭，仅在 `allowBrowserCookies: true` 且显式声明主机白名单的 profile 下生效，且只允许 HTTPS、同源重定向。
- 密钥只支持配置字面量、`$ENV_VAR` 引用和环境变量兜底；不支持 `!command` 动态取密钥，避免任意命令执行。
- 网页/搜索正文作为不可信数据传入模型（`fetch_content` 的 answer 模式、`auto-summary` 摘要），要求模型只引用来源、不执行其中的指令。

## 来源归属

本模块的能力范围参考了 [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)（MIT 许可，见本目录 [`LICENSE`](./LICENSE)）的设计，不依赖、不引用其代码，以自组件重新实现，仅保留 Brave/Exa/OpenAI 三个搜索来源。

## 测试

单元测试与源码相邻（`*.test.ts`），覆盖配置解析、密钥解析、SSRF/代理、provider 选择与回退、内容查找与缓存、authFetch 边界、四个工具的关键行为。执行 `npm test` 或仓库根目录的 `make test`（含覆盖率报告）。
