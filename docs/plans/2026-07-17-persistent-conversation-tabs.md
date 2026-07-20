# Persistent Conversation Tabs Implementation Plan

## Summary

为 Hermesian 添加持久化数字对话标签。每个已启动标签绑定真实 Hermes ACP session；active turn 期间新增标签先持久化为 deferred，turn 完成或之后空闲切换时再绑定真实 session。支持新增、切换、重启恢复和草稿恢复；现有 History、当前会话重建及 Thinking 重连会同步更新活动标签的 session ID。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/conversation-tabs.ts` | 新增 | 持久化 workspace 类型、校验和纯状态更新函数 |
| `tests/conversation-tabs.test.ts` | 新增 | 状态、迁移、无效输入及序号行为单测 |
| `src/main.ts` | 修改 | 加载/保存 workspace，暴露更新方法，命令路由到 View |
| `src/view.ts` | 修改 | 标签 DOM、运行时状态、新增/切换/恢复和 session 重绑定 |
| `src/hermes-session-catalog.ts` | 新增 | 读取当前 profile 未归档 ACP session 元数据并与实时列表合并 |
| `styles.css` | 修改 | 窄栏标签布局、选中态、横向滚动 |
| `tests/acp-client.test.ts` | 按需修改 | 保持 session load/new 行为回归覆盖 |
| `README.md` | 修改 | 记录多对话标签能力和行为边界 |

## Tasks

### Task 1：建立 conversation workspace 状态层

- **文件**：`tests/conversation-tabs.test.ts`、`src/conversation-tabs.ts`
- **实现**：
  1. 先写失败测试，覆盖空状态、初始化标签、追加标签、激活、更新草稿/开关、替换 session ID。
  2. 覆盖 v1→v2 迁移、v2 deferred binding、无效版本、重复 tab ID、空 session ID、无效 active ID 的 normalize 行为。
  3. 将编号作为数组位置的派生显示状态；新增、关闭和重启 normalize 后始终压缩为 `1…N`。
- **完成条件**：定向测试通过，模块无 Obsidian DOM 依赖。

### Task 2：接入插件数据持久化

- **文件**：`src/main.ts`、`src/settings.ts`、`src/types.ts`
- **依赖**：Task 1
- **实现**：
  1. 从现有平铺插件数据中显式读取设置字段和 `conversationWorkspace`。
  2. 提供 workspace getter、结构更新和保存接口。
  3. 设置保存与 workspace 保存统一合并，避免互相覆盖。
  4. View 关闭和结构变化时立即保存；草稿使用 debounce。
- **完成条件**：现有设置兼容，持久化数据不包含 Selection 正文。

### Task 3：实现标签栏和新建标签

- **文件**：`src/view.ts`、`styles.css`
- **依赖**：Task 2
- **实现**：
  1. 在 Header 添加 `+` 按钮和编号 `tablist`。
  2. 首次连接后创建标签 1，或恢复持久化活动标签。
  3. 空闲新建时调用 `client.newSession()`；active turn 期间立即追加并激活 deferred 标签，完成后再绑定 session。
  4. 添加 `role=tablist/tab`、`aria-selected`、title 和 disabled 状态。
- **完成条件**：空闲新增绑定不同非空 session ID；busy 新增为 deferred 且不能发送，安全边界后再绑定；窄栏不溢出。

### Task 4：实现切换与恢复

- **文件**：`src/view.ts`
- **依赖**：Task 3
- **实现**：
  1. 每个 tab 保存草稿、笔记上下文开关和内存 Selection。
  2. 切换时调用 `loadSessionHistory`，成功后才提交 activeTabId 并渲染历史。
  3. 恢复目标草稿、Selection 和 composer 状态。
  4. busy、permission pending、model switching 时禁止切换；加入 generation 防快速点击竞态。
  5. 启动恢复失败时替换活动标签 session；普通切换失败时保留原标签。
- **完成条件**：在多个标签间往返后，对话历史和草稿不串线。

### Task 5：统一其他 session 入口

- **文件**：`src/main.ts`、`src/view.ts`
- **依赖**：Task 4
- **实现**：
  1. Command Palette 的 **Restart current conversation** 重建当前标签并替换其 session ID；header 不显示重复按钮。
  2. History 恢复到当前标签并更新 session ID。
  3. Thinking 重连后更新当前标签 session ID。
  4. 插件命令 `new-hermes-session` 路由到 View，避免绕过 tab 状态。
- **完成条件**：所有创建/加载 session 的路径都同步 workspace。

### Task 6：文档、视觉回归与发布验证

- **文件**：`README.md`、临时 `hermes-verify-*` fixture
- **依赖**：Tasks 1–5
- **实现**：
  1. 更新 README。
  2. 创建窄 sidebar fixture，验证 tabs 横向滚动、active 边框和 header actions 可见；完成后删除。
  3. 运行 `npm run test`、`npm run typecheck`、`npm run build`、`git diff --check`。
  4. `npm run deploy`，逐字比对三项产物，通过 Advanced URI `app:reload`。
- **完成条件**：canonical commands 全通过、部署产物一致、Obsidian 正常运行。

## Constraints

- 不提交或 push Git，除非用户另行要求。
- 不修改现有未提交功能之外的无关代码。
- 不持久化 Selection 正文或绝对路径。
- 不允许 busy 时切换 session。
- 已启动标签必须绑定真实 ACP session ID；deferred 标签不能发送，且会在安全边界绑定 session，不用纯 DOM 缓存冒充独立对话。

### Task 5A：关闭标签与 profile History

- **文件**：`src/conversation-tabs.ts`、`src/view.ts`、`src/acp-client.ts`、`src/hermes-session-catalog.ts`
- **实现**：
  1. 右键数字标签直接关闭；不删除或归档底层 session。
  2. 关闭活动标签时恢复相邻 session；最后一个标签关闭时创建替代 session。
  3. History 合并 ACP 实时列表与当前 profile `SessionDB` 中未归档 `acp` sessions。
  4. 按 session ID 去重和时间排序；任一数据源失败时由另一数据源降级。
- **完成条件**：关闭 reducer、catalog parser/merge 测试通过；关闭的 session 可在 History 中重新载入。

### Task 5B：回复期间安全切换标签

- **文件**：`src/conversation-tabs.ts`、`src/view.ts`、`styles.css`、`tests/conversation-tabs.test.ts`
- **实现**：
  1. 用纯状态规则区分 idle load、active-turn local switch、blocked 和 noop。
  2. 为每个标签维护运行时消息 DOM 缓存，后台流式事件继续绑定原工作标签。
  3. 非工作标签允许查看和编辑草稿，但当前 turn 结束前保持发送禁用。
  4. turn 完成后自动 `session/load` 当前可见标签；失败则恢复工作标签。
  5. 权限请求自动显示工作标签，并以 working 状态标记后台标签。
  6. 区分 terminal/recoverable error，并在 ACP client 层禁止 busy `session/load`。
  7. 后台流式事件只更新隐藏 DOM，不改变前台标签滚动位置。
  8. active turn 期间 Add 创建可持久化 deferred 标签；当前 turn 完成后启动可见 deferred tab，其他 deferred tab 在空闲切换时启动。
  9. shell 渲染后立即锁定 controls，直到 `connect + workspace/session restore` 整体完成，禁止启动期 Add 与 `session/load` 并发。
- **完成条件**：回复期间可反复切换且事件不串线；完成后当前标签可继续发送；单 ACP 不并行 prompt。
