# Hermesian 持久化多对话标签设计

## 背景

Hermesian 最初只维护一个 ACP session。持久化标签第一版允许回复期间切换和新增，但共享 connection 仍使其他标签必须等待。当前设计将隔离边界升级为 `tabId → HermesAcpClient → hermes acp process → ACP session → UI turn runtime`，使多个真实 Hermes session 可并行运行并跨 Obsidian 重启恢复。

## 目标

- 每个已启动标签对应一个独立、可继续的 Hermes ACP client、进程和 session；新标签可在自己的 client 启动前短暂处于 deferred 状态。
- `+` 新建标签；编号按钮切换标签；当前标签使用明确选中态。显示编号始终按从左到右压缩为 `1…N`。
- 标签、活动标签、session ID、输入草稿和笔记上下文开关跨重启保存。
- Selection 仅在当前 Obsidian 运行期间按标签保留，不写入插件数据。
- History 和重建当前会话只改变目标标签；Thinking 是 profile-global 配置，变更时释放全部 clients，并由活动标签重新加载原 session。
- 右键数字标签直接关闭该标签，但不删除或归档底层 Hermes session。
- History 显示当前 Hermes profile 中全部未归档、可由 ACP 恢复的会话。
- 回复期间允许切换、新增和发送；每个标签仍严格 single-flight。

## 非目标

- 本轮不实现标签重命名或拖拽排序。
- 不把所有历史会话自动映射成标签。

## 数据模型

新增纯状态模块 `src/conversation-tabs.ts`：

```ts
interface PersistedConversationTab {
  id: string;
  label: number;
  sessionId: string | null; // null = this tab's client has not created a session yet
  draft: string;
  includeCurrentDocumentContext: boolean;
}

interface PersistedConversationWorkspace {
  version: 2;
  activeTabId: string;
  nextLabel: number;
  tabs: PersistedConversationTab[];
}
```

模块负责校验持久化输入、创建初始 workspace、追加/关闭标签、激活标签、更新草稿/上下文开关和替换 session ID。schema v1 的真实 session binding 自动迁移到 v2；v2 允许 deferred 标签使用 `null`，但发送前必须绑定真实 session。`label` 和 `nextLabel` 是按当前标签数组位置重新计算的显示状态；关闭后立即重排，启动时也会把旧的跳号数据修复为连续编号。无效格式回退为空 workspace，不影响 Hermes 设置读取。

Selection 包含正文和绝对路径，只保存在 View 内存中的 `Map<tabId, SelectionContext | undefined>`，不持久化。

## 插件数据职责

`HermesianPlugin` 同时持有设置和 conversation workspace，并通过同一个 `loadData/saveData` 文档保存。保存时写入：

```ts
{
  ...settings,
  conversationWorkspace
}
```

设置加载只读取已知设置字段，避免 workspace 混入 `HermesianSettings`。View 通过插件方法读取、更新并保存 workspace。草稿更新采用短延迟 debounce；切换、关闭 View 和结构变化时立即保存。

## View 生命周期

### 首次打开

1. 渲染 shell 和标签栏。
2. 为活动标签 lazy acquire 独立 client，并由该 client 创建可用 ACP session。
3. 若没有有效持久化标签，用当前 session ID 创建标签 1。
4. 若有标签，调用 `session/load` 恢复活动标签；成功后渲染历史和草稿。
5. 若持久化 session 已失效，则为活动标签创建新 session、替换 session ID 并显示提示；其他标签保持不变。

### 新增标签

1. 保存当前标签草稿、上下文开关和内存 Selection。
2. 立即追加 `sessionId: null` 的标签并激活，允许用户编辑草稿。
3. 为新标签 acquire 独立 client；`connect()` 完成后写回 session ID 并启用 Send，不等待其他标签的 turn。
4. 若用户在连接完成前切走，新标签继续在后台初始化；再次切回时恢复其草稿和缓存。
5. 按当前标签顺序重新计算 `1…N`，重置消息区和 Selection，渲染标签栏并持久化。

### 切换标签

1. 仅 initialization 阶段拒绝切换；其他标签 busy 不影响切换。
2. 保存当前标签运行时状态。
3. 若目标标签 client 尚未 materialize，则独立 connect 并 `session/load(target.sessionId)`；已加载的标签直接复用 DOM/runtime 缓存。
4. 成功后激活目标标签、渲染历史、恢复草稿/开关/Selection，并持久化活动标签。
5. 加载失败时保留原活动标签和界面，并显示 Notice；不静默串 session。

### 回复期间的后台切换与并行发送

Hermesian 为每个标签 lazy 创建一个 ACP connection，并允许不同标签同时运行 prompt：

1. 每个标签在当前 Obsidian 运行期间持有独立的消息 DOM 缓存；切换时移动现有节点，保留 Markdown、工具卡和流式节点引用。
2. client callback 在创建时闭包捕获稳定 `tabId`；文本、thinking、工具、usage、错误、permission 和 stop 不读取可变的活动标签。
3. Send/Stop/History/Model 是 tab-local controls：A busy 只禁用 A；B idle 时仍可发送。Thinking/profile/executable 是 profile-global 操作，任一 client busy 时禁用。
4. 每个标签的 client 和 turn 都严格 single-flight；`sendPrompt()` 在第一个 `await` 前占有 busy slot。
5. 权限请求自动显示来源标签，并把决议返回原 client；其他标签 runtime 不受影响。
6. registry 在 release 前先删除 client identity；关闭/重建后旧 client 的迟到 event/state/permission 一律丢弃。
7. ACP `error` 明确区分 terminal 与 recoverable；权限拒绝等 recoverable error 只显示错误，不结束 turn。
8. `session/load` 在该 client busy 时直接拒绝；同一 session ID 不允许同时绑定两个打开标签。
9. 隐藏工作标签的流式事件不得滚动当前可见标签；自动滚动按 RAF 执行时的标签归属判断。

### 关闭标签

1. 数字标签的 `contextmenu` 事件阻止系统默认菜单并直接关闭标签。
2. 关闭标签会释放该标签的 client/process；不影响其他标签。关闭活动标签时优先恢复右侧相邻标签，否则恢复左侧标签。
3. 关闭最后一个标签时先创建新 ACP session，再移除旧标签，保证 workspace 和 composer 始终可用。
4. 只移除本地标签和运行时 Selection；不删除、不归档底层 Hermes session，因此可从 History 找回。
5. 对剩余标签从左到右重新编号为 `1…N`；tab ID、session ID 和 active tab 绑定保持不变。
6. busy、permission pending 或 model switching 时拒绝关闭，避免回复串线。

### 其他 session 变更

- Command Palette 的 **Restart current conversation**：创建新 session，并替换当前标签的 session ID，不新增标签；header 不再显示重复的 restart 按钮。
- History：加载选中历史，并替换当前标签的 session ID。
- Thinking 重连：更新 profile 配置后释放全部 idle clients；活动标签重新加载原 session，其他标签按需 lazy reload。
- profile/executable reconnect 后若旧 session 不可恢复，按启动恢复失败策略处理。

History 的数据源是两个可降级合并的列表：ACP `session/list` 提供当前进程实时元数据；`src/hermes-session-catalog.ts` 通过 Hermes 自身 Python runtime 读取当前 profile 的 `SessionDB.list_sessions_rich(source="acp", include_archived=false)`，补齐 ACP adapter 默认隐藏的空 session 和已关闭标签。按 session ID 去重并按更新时间降序排列；只展示 `acp` source，因为 Hermes ACP adapter 不能加载其他 source。

## UI

Header 分成两层：

1. 第一层保留 Hermesian identity、状态、`+` 和 History；restart 仅在 Command Palette 提供。
2. 第二层为 `.hermesian-conversation-tabs`，编号按钮水平滚动。

标签按钮最小 34×34px；当前标签使用 `--interactive-accent` 边框和 `aria-selected=true`。标签容器设置 `min-width: 0; overflow-x: auto; white-space: nowrap`，不允许撑破窄 sidebar。

## 错误与并发

- Header 渲染后立即进入 initialization busy；`connect()` 与 workspace/session 恢复完成前不得开放 Add、History、模型或 session 切换，避免 `session/new` 与启动 `session/load` 竞态。
- 新建/History/Restart/loading 只锁目标标签；其他 idle 标签仍可发送。
- 响应进行中允许标签切换和跨标签并行发送；busy/permission pending 标签自身不可关闭或重复发送。
- `session/load` 失败不改变活动 tab 状态。
- 持久化失败显示 Notice，但不使当前会话不可用。
- registry identity gate 防止 release/recreate 后的旧 client 迟到事件污染新 runtime。

## 测试

- 纯状态单测：初始化、追加、激活、关闭活动/非活动/最后标签、反复关闭新增后的连续编号、旧跳号数据迁移、草稿更新、session 替换、无效数据恢复。
- History catalog 单测：profile helper 输出规范化、去重、实时数据覆盖和时间排序。
- View/协议路径：A busy 时 B 可发送、同标签 single-flight、不同标签独立 client/session、事件归属、Stop/permission/release 隔离、History/重建更新目标 session ID。
- 持久化：保存后重新加载仍恢复活动标签和草稿，Selection 不出现在数据中。
- UI fixture：窄栏多标签横向滚动，选中态清晰，右侧按钮不被挤出。
- 最终运行 `npm run test`、`npm run typecheck`、`npm run build`、`npm run smoke:acp` 和 `npm run smoke:acp:parallel`，部署并通过 Advanced URI reload。
