# Hermesian Obsidian 插件设计

## 背景

用户以 Obsidian Markdown 知识库为核心工作环境，需要在活动笔记中选择文本，在右侧栏与 Hermes Agent 对话，并让 Hermes 基于选区、笔记上下文和整个 Vault 生成受控修改。

## 目标

- 在 Obsidian Desktop 右侧栏提供 Hermes 对话界面。
- 通过 `hermes acp` 复用 Hermes 的模型、skills、memory、文件、terminal 与 web 能力。
- 捕获活动 Markdown 文件、选区范围、选区文本和必要的前后文。
- 将 Hermes 的流式文本、思考和工具活动显示在侧栏。
- 对 `patch` / `write_file` 使用 ACP 原生 pre-edit diff approval；用户同意前不修改文件。
- 所有客户端文件访问限制在当前 Vault 内。
- 插件卸载或连接失败时可靠终止子进程并拒绝未完成审批。

## 非目标（MVP）

- 不支持 Obsidian Mobile。
- 不实现完整 IDE、LSP 或多文件可视化编辑器。
- 不在第一版实现 CodeMirror 行内 ghost diff；MVP 在侧栏展示 diff。
- 不支持 Reading View 到 Markdown source range 的精确映射；选区命令面向 Source/Live Preview。
- 不修改 Hermes core。

## 架构

```text
Obsidian MarkdownView
  -> SelectionContextService
  -> HermesianSidebarView
  -> HermesAcpClient
  -> official @agentclientprotocol/sdk / NDJSON stdio
  -> hermes acp --accept-hooks
  -> Hermes AIAgent (cwd = vault)
```

### Obsidian 插件层

- `HermesianPlugin`：生命周期、命令、右栏注册、设置加载。
- `HermesianSidebarView`：消息、选区 chip、工具卡、审批 diff、composer。
- `HermesAcpClient`：子进程、initialize、session/new、prompt、cancel、事件分发。
- `SelectionContextService`：从 `MarkdownView.editor` 读取选区和上下文。
- `VaultFileService`：canonical path 校验及 ACP 客户端 fs 回调。
- `HermesianSettingTab`：Hermes executable、profile、上下文行数。

### ACP 连接

- 使用官方 `@agentclientprotocol/sdk`，不手写 JSON-RPC framing。
- 启动 `hermes acp --accept-hooks`；子进程 `cwd` 设置为 Vault。
- 通过环境变量传 `HERMES_PROFILE` 和 `HERMES_ACCEPT_HOOKS=1`。
- 当前 Hermes CLI 不支持 `hermes acp --cwd`；Vault cwd 由子进程选项和 ACP `session/new` 传入。
- `initialize.protocolVersion` 使用 SDK 的 `PROTOCOL_VERSION`。
- stdout 仅承载 NDJSON；stderr 作为诊断日志。

## 数据流

### 普通聊天

1. 用户在侧栏输入消息。
2. 插件确保 ACP 连接及 session 已创建。
3. 调用 `session.prompt()`。
4. 循环读取 `session/update`，按类型渲染消息和工具状态。
5. 收到 stop 后恢复输入状态。

### 选区编辑

1. 用户执行 “Ask Hermes about selection” 或点击添加选区。
2. 插件采集 Vault-relative path、1-based 行范围、字符范围、选区、前后文和快照 hash。
3. 选区作为结构化纯文本上下文与用户要求一起发送。
4. 提示 Hermes 优先使用 `patch(mode=replace)` 做最小修改。
5. Hermes 请求 `patch` / `write_file` 时，ACP 在执行前发送 `session/request_permission`，携带 diff。
6. 侧栏显示 old/new diff 与允许/拒绝按钮，并返回 ACP 规定的 `outcome.selected` envelope。
7. 允许后 Hermes 执行写入，Obsidian 通过 Vault 文件监听刷新编辑器；拒绝则文件不变。

## 安全与冲突

- 所有客户端 fs 路径必须在 `FileSystemAdapter.getBasePath()` 的 canonical root 内。
- 默认逐次询问编辑权限，不启用 session 自动接受。
- 不使用 `--yolo`；terminal 权限按 ACP option 原样呈现。
- 发请求前保留选区快照；审批时如活动文件内容已变化，UI提示用户重新生成。
- 进程退出、插件卸载或审批超时统一返回取消/拒绝。
- 不把 API key 写入插件设置；Hermes 读取所选 profile 的既有配置。

## UI

- 原生 Obsidian `ItemView` 与 DOM helpers，不引入 React。
- 顶部：连接状态、新会话、当前 profile。
- 主区：用户/助手消息、tool cards、pending diff approval。
- Composer：多行输入、发送/停止按钮、选区 chip。
- 命令与 ribbon：打开 Hermesian、将当前选区发送到 Hermesian。

## 测试

- 纯函数单元测试：选区 prompt、路径 containment、diff 文本渲染。
- TypeScript：`tsc --noEmit`。
- Build：esbuild 输出 `main.js`。
- ACP smoke：启动真实 `hermes acp`，initialize、new session、发送受控 prompt、验证流式文本/stop。
- 部署验证：`main.js`、`manifest.json`、`styles.css` 写入 Vault 插件目录，启用列表采用 merge。
- 若 Obsidian CLI 可用且应用运行，执行 plugin reload 和错误/console 检查。

## 后续版本

- CodeMirror 6 inline decorations 和逐 hunk Accept/Reject。
- 会话列表、resume/fork。
- 附件与图片 content block。
- 远程 Hermes API 模式和移动端支持。
