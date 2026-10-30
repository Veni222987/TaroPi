---
name: diagram-drawio
description: 用 drawio MCP（经 mcporter 调用）绘制架构图、流程图、时序图、部署图等 draw.io 图表，并导出 drawio、PNG、SVG。仅当用户明确要求画图表、改图表或导出 .drawio 文件时使用；生成或修改位图、照片、插画请用 draw skill，不要主动为其他任务配图。
---

# draw.io 画图

通过 mcporter 调用 `@next-ai-drawio/mcp-server`，由 Agent 写 draw.io XML，MCP 负责校验、预览、保存和导出。

## 1. 环境准备

每次使用前先跑一次，已配置时它什么都不会改：

```bash
bash <skill目录>/scripts/setup.sh --dry-run
bash <skill目录>/scripts/setup.sh
```

`--dry-run` 只打印将要做的改动。脚本做这些事，且可重复执行：

- 在 `~/.mcporter/mcporter.json`（可用 `MCPORTER_CONFIG` 覆盖）里补全 `drawio` 条目。已有条目只补缺少的 `lifecycle` 和 `env.DRAWIO_DATA_DIR`，不覆盖其他字段；有改动时先备份为 `mcporter.json.bak-<时间戳>`。
- 设为 `keep-alive` 并启动 daemon。mcporter 默认每次调用新起进程，而画布会话存在 MCP 进程里，不保活就对不上同一张图。
- 补 `env.BROWSER=none`，不让 MCP 自己去打开浏览器，预览页由下面的无头浏览器打开。
- 调用 `scripts/install-browser.sh` 把 `chrome-headless-shell` 装到 `~/.local/bin`（已装就跳过）。默认从 npmmirror 的 Chrome for Testing 镜像下载 156.0.8078.80，约 120MB，缓存在 `~/.cache/next-drawio`。不想装用 `--no-browser`。
- 建好下面两个目录。
- 配置有变更且 daemon 正在运行时会重启 daemon，未保存的画布会话会断开，已保存的 `.drawio` 不受影响。

不再使用时用 `mcporter daemon stop` 关掉常驻进程。MCP 由 `npx @latest` 按需拉取，首次调用需要联网，会比较慢。

## 2. 目录约定

数据根目录为 `~/.local/share/next-drawio`（设置了 `XDG_DATA_HOME` 时为 `$XDG_DATA_HOME/next-drawio`）。

| 目录 | 内容 | 注意 |
| --- | --- | --- |
| `src/` | 图的原始文件：MCP 自动保存的 `mcp-<id>.drawio` 和 `.history.json`，以及自定义规则 `instructions.md` | 由 MCP 写入，不要手工改 `.drawio`，修改一律用 `edit_diagram` |
| `exported/` | 导出的 `.drawio`、`.png`、`.svg` | `export_diagram` 的 `path` 一律用此目录下的绝对路径，文件名用能看出主题的短名 |

`src/` 来自 `DRAWIO_DATA_DIR`，所以 `instructions.md` 也读这个目录。若旧版本把图存在 `~/.next-ai-drawio/`，换目录后 `list_saved_diagrams` 看不到旧图，需要时手动移过去。

画第三方项目时，克隆的源码放在当前仓库之外，不要把图和源码写进当前仓库。

## 3. 画图工作流

1. `start_session` 开会话，返回值里有完整的绘图指南（布局、连线、样式规则）和预览地址，按它画，不要凭记忆写 XML 规范。上下文里丢了指南就调 `get_drawing_guide`。
2. 先读真实代码或文档再画。MCP 只接收 XML，不接收文件、图片或网页，内容要自己读。
3. 动手前用 2 到 3 句话说明布局计划：分几块、每块放什么、主要连线方向。
4. 要用云厂商或设备图标（AWS、Azure、GCP、Kubernetes、Cisco、BPMN 等）时，先 `get_shape_library` 取准确的 style 名，不猜。
5. `create_new_diagram` 提交整张图；局部调整用 `edit_diagram`，改动按 id 定位。
6. 先用 `preview.sh` 打开预览（见第 5 节），再 `export_diagram` 导出 PNG 到 `exported/`，再用 `read` 看图自检：连线穿过其他框、文字重叠、标签压线、内容被截断。有问题就改完重新导出，直到干净。
7. 汇报时给出导出文件的绝对路径，并说明哪些内容是读代码确认的、哪些是推断的。

复杂图在 `create_new_diagram` 或 `edit_diagram` 上传 `screenshot: true` 也能在返回里看到渲染结果。导出和截图都需要预览页已打开，见第 5 节。

## 4. 调用方式

统一用 `mcporter call drawio.<工具>`。短参数用 `key=value`，长 XML 用 JSON 文件传，避免 shell 转义：

```bash
mcporter call drawio.start_session --timeout 120000
bash <skill目录>/scripts/preview.sh start "<Browser URL>"

node -e 'const fs=require("fs");fs.writeFileSync("/tmp/args.json",JSON.stringify({xml:fs.readFileSync("/tmp/diagram.xml","utf8")}))'
mcporter call drawio.create_new_diagram --args "$(cat /tmp/args.json)" --timeout 120000

mcporter call drawio.export_diagram path="$HOME/.local/share/next-drawio/exported/架构图.png" format=png --timeout 60000
```

`format` 可选 `drawio`、`png`、`svg`、`drawio.svg`。只发 `mxCell` 元素，服务端会补外层包装。

| 工具 | 用途 |
| --- | --- |
| `start_session` | 开始或续接会话，`session_id` 可续接旧图 |
| `list_saved_diagrams` | 列出 `src/` 里已保存的图 |
| `create_new_diagram` | 整张替换为新图 |
| `edit_diagram` | 按 id 增删改单元格，全成功或全失败 |
| `get_diagram` / `get_selection` | 读当前 XML（含用户手改）/ 读用户选中的单元格 |
| `screenshot_diagram` | 取渲染截图 |
| `export_diagram` | 导出文件 |
| `list_pages` / `add_page` / `rename_page` / `delete_page` | 多页管理 |
| `load_diagram` | 载入已有 `.drawio` 文件 |
| `restore_version` | 回退到更早的版本 |

修改已有的 `.drawio` 文件：先 `load_diagram`，再 `edit_diagram`，最后 `export_diagram` 回同一路径，不要手写它的 XML。

## 5. 无头预览

`export_diagram`、`screenshot_diagram`、`get_selection` 都是在浏览器预览标签页里渲染的。没有标签页连着时，导出会报 `No diagram to export` 或 `Export timed out`，这是实测到的现象。用 `preview.sh` 起一个无头 `chrome-headless-shell` 来当这个标签页，不需要图形界面：

```bash
bash <skill目录>/scripts/preview.sh start "<start_session 返回的 Browser URL>"
bash <skill目录>/scripts/preview.sh status
bash <skill目录>/scripts/preview.sh stop
```

- 每次 `start_session` 的会话 id 都会变，换会话后重新跑 `start`，它会先关掉旧预览再打开新的。只接受 `http://localhost:<端口>/shell/?mcp=<id>` 形式的地址。
- 预览进程常驻，画完、导出完后跑 `stop` 关掉。
- 浏览器路径按 `DRAWIO_CHROME`、`~/.local/bin/chrome-headless-shell`、`PATH` 的顺序查找。
- 想自己在本机浏览器里看实时预览，把 `Browser URL` 的端口转发出来即可，端口转发取决于各自的终端或编辑器，本 skill 不负责。

导出失败时，先 `preview.sh status` 确认预览在跑且地址对应当前会话，再确认 `mcporter daemon status` 里 `drawio` 是 `connected`。没有安装浏览器且装不了时，只能交付 `src/` 里自动保存的 `.drawio`，并如实说明没有做过图片自检。`create_new_diagram` 的 XML 校验在服务端完成，不依赖浏览器。

## 6. 自定义规则

把自己的画图规则（配色、字体、命名习惯）写到 `~/.local/share/next-drawio/src/instructions.md`，上限 5000 字符。每次调用都会重新读取，不需要重启，内容追加在 MCP 绘图指南之后。
