# Hermesian

Hermesian 是一个面向 Obsidian Desktop 的 Hermes Agent 侧边栏插件。它通过 ACP（Agent Client Protocol）连接当前 Vault，在原生 Obsidian 侧栏中提供对话、Markdown 选区上下文、工具活动流和写入前 diff 审批。

> 当前版本：`0.1.4` · 仅支持 Obsidian Desktop

## 主要功能

- **原生侧栏对话**：在 Obsidian 右侧边栏中使用 Hermes Agent。
- **独立并行会话**：每个数字标签拥有独立的 ACP client、进程、session 和 turn runtime；一个会话运行时，可以切换到其他标签并立即发送消息。
- **会话恢复**：持久化标签、Hermes session、草稿、活动标签和笔记上下文开关；重启 Obsidian 后恢复。
- **History**：浏览当前 Hermes profile 中未归档的历史会话，并将其加载到当前标签。
- **Markdown 上下文**：可将当前笔记或选中的文本作为上下文发送给 Hermes。
- **工具活动流**：实时展示 thinking、tool call、权限请求、错误和上下文用量。
- **写入前审批**：对 `patch` / `write_file` diff 进行 Vault 边界校验，并在写入前展示变更。
- **模型与 slash commands**：搜索已认证 Hermes provider 的模型，并使用 Hermes skills 与 slash commands。
- **主题自适应**：使用 Obsidian semantic tokens，适配浅色、深色和第三方主题。

## 环境要求

- Obsidian Desktop `1.8.0` 或更高版本
- 支持 `hermes acp` 的 Hermes Agent
- 已配置的 Hermes profile

先确认 Hermes 可用：

```bash
hermes acp --check
```

## 安装与启动

从 [GitHub Releases](https://github.com/CaseyTso/hermesian/releases/latest) 下载最新版本。可以直接解压 `hermesian-vX.Y.Z.zip`，也可以分别下载以下三个文件：

- `main.js`
- `manifest.json`
- `styles.css`

将文件放入 Vault 的插件目录：

```text
<Vault>/.obsidian/plugins/hermesian/
├── main.js
├── manifest.json
└── styles.css
```

完全重启 Obsidian，然后在 **设置 → 第三方插件** 中启用 Hermesian。

> **不要把 GitHub 的 Code → Download ZIP 当作安装包。** 该压缩包只包含源码，并且有意排除了编译后的 `main.js`。

如需从源码安装，先构建再复制上述三个产物：

```bash
npm install
npm run build
```

## 使用方法

1. 打开命令面板，执行 **Hermesian: Open Hermesian sidebar**。
2. 点击顶部 **+** 创建独立对话标签。标签编号始终从左到右连续排列为 `1…N`；右键标签可以关闭本地标签，不会删除底层 Hermes session。
3. 在 Composer 中选择模型和 thinking depth；context meter 会显示当前 session 的估算用量。
4. 在 Markdown 笔记中选中文本后，执行 **Hermesian: Ask Hermes about selection**，或点击 Composer 中的 **Add selection**。
5. 输入请求并按 `Enter` 发送；按 `Shift+Enter` 换行。
6. Hermes 请求文件编辑时，插件会检查 diff 是否位于当前 Vault 内，并在写入前展示审批界面。
7. 如需丢弃当前上下文但保留标签，执行 **Hermesian: Restart current conversation**。

没有选区时，当前 Markdown 文件会作为可写上下文发送；有选区时，插件会发送完整 Markdown 文件和选区，并拒绝修改选区之外内容的 diff。

## 设置

- **Hermes executable**：Hermes 可执行文件名或绝对路径。设置为 `hermes` 时，插件也会检查常见安装目录。
- **Hermes profile**：传递给 Hermes 的全局 `--profile` 参数。留空时使用 Hermes 当前 profile。
- **Accept startup hooks**：以 `hermes acp --accept-hooks` 启动，不会自动批准工具或文件编辑。
- **Automatically approve Vault edits**：仅对经过 Vault 边界校验、包含可验证 diff 的 `edit` 请求自动批准；终端请求、Vault 外路径、符号链接逃逸和不可验证 diff 仍需要人工处理。

## 安全与隐私

- 文件读取会进行规范化和 Vault 边界校验，并检查符号链接逃逸。
- 插件不会保存模型 API key。
- 选中的笔记文本只在当前运行期间保存在内存中，不写入插件数据。
- 标签会持久化 Hermes session ID（或 deferred-start 标记）和未发送草稿。
- ACP 的工作目录不是完整的 terminal sandbox；请继续使用 Hermes 的命令审批机制。
- 使用自动 Vault edit approval 前，请确认 Hermes profile 和 Vault 设置正确。

## 开发

要求 Node.js `20+`：

```bash
npm install
npm run typecheck
npm test
npm run build
```

真实 ACP smoke tests：

```bash
npm run smoke:acp
npm run smoke:acp:parallel
```

将构建产物部署到本地测试 Vault 时，必须显式设置 Vault 路径：

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/obsidian-vault"
npm run deploy
```

`npm run deploy` 只复制 `main.js`、`manifest.json` 和 `styles.css`，并自动启用 Vault 中的 Hermesian 插件。

完整验证：

```bash
npm run verify
```

## 架构

核心并发边界为：

```text
tabId → HermesAcpClient → hermes acp process → ACP session → UI turn runtime
```

不同标签可以并行运行；同一标签内部仍保持 single-flight。相关设计和实施文档：

- [初始设计](docs/design/2026-07-15-hermesian-obsidian-design.md)
- [MVP 计划](docs/plans/2026-07-15-hermesian-mvp.md)
- [持久化对话标签设计](docs/design/2026-07-17-persistent-conversation-tabs-design.md)
- [持久化对话标签计划](docs/plans/2026-07-17-persistent-conversation-tabs.md)
- [Obsidian 原生界面精修设计](docs/design/2026-07-21-obsidian-native-ui-polish-design.md)
- [Obsidian 原生界面精修计划](docs/plans/2026-07-21-obsidian-native-ui-polish.md)

## 许可证

当前仓库尚未附加开源许可证。代码的使用、修改和再分发请先取得作者许可。
