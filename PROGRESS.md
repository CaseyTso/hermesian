# PROGRESS

## 本轮目标
断开 Obsidian 启动与 Hermes ACP 初始化：onOpen 不 await 连接。

## 任务 0
- verify 绿：27→28 files / 332→339 tests / 0 skipped
- coverage 基线：S89.81 B79.18 F90.74 L89.72（覆盖白名单未含 view-startup，数值保持）
- 保护指纹 dc962cee…bbcf MATCH
- 根因：view.ts onOpen 曾 await controller.initialize()
- 冷启动探针不足 → BLOCKED（不写成通过）

## 完成
1 红灯→实现 ViewStartupCoordinator + view.ts 接线
2 布局未 ready / init 永不结束：begin <100ms 且不启动
3 layout ready 后单次后台 init；失败可 retry；close 忽略晚到结果
4 反向：busy-wait onStart → 1 fail；还原 7 pass
5 verify 339；coverage 基线持平；deploy cmp main/manifest/styles=0

## 反向证据
坏逻辑：layout ready 时 onStart busy-wait 150ms →
`defers initialization even when layout is already ready` 红
还原后 7/7 绿。

## 真人冷启动
用户确认：不开安全模式可正常进入；启动阻塞已解除。

---

## 本轮目标（tab 延迟）
恢复旧会话跳过无用 session/new；新 tab UI≤100ms 可见；实测延迟下降。

## 任务 0 开工回执（2026-07-30）
- verify 绿：28 files / 339 tests / 0 skipped
- coverage：S89.81 B79.18 F90.74 L89.72
- 保护指纹 fa338048…4c13 MATCH
- 三轮基准（scripts/acp-latency.mjs）：
  - fresh 中位 14128ms（init~0.47s + new~13.7s）
  - resume(old new+load) 中位 28558ms
  - direct(init+load) 中位 14814ms，session_new=0

## 完成（tab 延迟）
1 红→绿：resume 仅 load；fresh 仍 connect/new 一次
2 acp-client：ensureTransport / startFreshSession / load=transport+load
3 controller：有 sessionId → load；无 → connect；load 失败 → newSession 一次
4 反向：临时 connect-before-load → 2 红；还原 2 绿
5 新 tab：100ms 内 pending 可见；connect 永不结束仍可切/关
6 实测后：direct 中位 14698ms（相对 old resume −48.5%）；fresh 中位 14404ms
7 verify 346 tests；coverage S90.08 B79.46 F90.74 L90.00；指纹不变；deploy 三文件 cmp=0

## 调用序列
- persisted：initialize → session/load（session/new=0）
- fresh：initialize → session/new（1）
- load 失败回退：load → newSession（恰好 1 次 new）

---

## 晚到响应修复开工（2026-07-31 11:43:03）
- 仓库：/Users/juicewrld/Downloads/Hermes Agent/hermesian（pwd 锁定）
- 基线：28 files / 346 tests / 0 skipped；S90.08 B79.46 F90.74 L90.00
- 保护指纹 b50a2f08…7197 MATCH
- 目标：disconnect 后 load/new/setModel 晚到结果不得复活 session/状态/UI
- 顺序：红灯竞态测试 → 统一 lifecycle 所有权校验 → 反向 → 50轮 → 全量/延迟/部署
- 最大风险：只挡 load 漏掉 new/setModel；或把普通 load 失败误判为 cancelled

## 任务1 红灯证据（2026-07-31）
定向：`npx vitest run tests/acp-client.test.ts -t late-response`
3 failed | 1 passed：
1. load after disconnect → sessionId 复活为 `saved-session`
2. newSession after disconnect → sessionId 复活为 `late-fresh-session`
3. setModel after disconnect → currentModel 被晚到结果覆盖
第4项正常路径已绿。

## 完成（晚到响应修复 2026-07-31 11:56:30）
1 红灯：load/new/setModel 晚到分别复活 sessionId/model（3 fail）
2 实现 assertLifecycleOwned + captureLifecycle；load/new/setModel await 后提交前校验
3 反向：去掉 load 校验 → sessionId=saved-session 红；还原绿
4 50/50 late-response 压力 0 flaky
5 verify 350 tests 0 skipped；coverage S90.08 B79.60 F90.74 L90.00
6 direct 中位 6160ms new=0；fresh 中位 5808ms new=1；deploy cmp=0；指纹 b50a2f08…7197

---

## aborted transport 修复开工（2026-07-31 12:18:30）
- 仓库：/Users/juicewrld/Downloads/Hermes Agent/hermesian（pwd 锁定）
- 基线：28 files / 350 tests / 0 skipped；S90.08 B79.60 F90.74 L90.00
- 保护指纹 b50a2f08…7197 MATCH
- 目标：connection.signal.aborted 后晚到 load/new/setModel 不得提交；旧 closed 不伤新连接
- 顺序：红灯 aborted 测试 → assertLifecycleOwned 含 aborted + closed 收口 → 反向/50轮 → 全量/延迟/部署
- 最大风险：只比引用漏 aborted；或 closed 误杀新 connection

## 任务1 红灯证据（aborted transport）
定向：`npx vitest run tests/acp-client.test.ts -t 'aborts|signal abort|old connection'`
3 failed | 1 passed：
1. load after signal.aborted → sessionId 复活为 `aborted-session`
2. newSession after signal.aborted → sessionId 复活为 `aborted-fresh-session`
3. setModel after signal.aborted → promise fulfilled（晚到提交）
旧 connection.closed 不伤新连接：已绿（generation/引用守卫）

## 完成（aborted transport 修复 2026-07-31 12:23:53）
1 红灯：signal.aborted 后 load/new/setModel 仍提交（session 复活 / fulfilled）
2 assertLifecycleOwned 增加 connection.signal.aborted 硬条件
3 handleConnectionClosed 统一收口：仅当前 generation+connection 清理；旧 closed 不伤新连接
4 反向：去掉 aborted 条件 → sessionId=aborted-session 红；还原绿
5 late-response 50/50 0 flaky
6 verify 354 tests 0 skipped；coverage S90.08 B79.60 F90.74 L90.00
7 direct 中位 6077ms new=0；fresh 中位 6275ms new=1；deploy cmp=0；指纹 b50a2f08…7197

---

## 本轮（token 误识别修复 + 日志恢复 + 清理 2026-07-31 14:53）
- 仓库：hermesian，分支 main，基线 28 files / 364 tests / 0 skipped
- 视觉指纹保持：273dcffc5dc62b30d1bb1dfc44c3bd7da615ca2e1189a72dd02f55c10420a693
- 目标：修复三个遗留问题——未知 `/文字` 误包装、进度历史被删除、预览图污染仓库

## 修正
1. **parseComposerSlashDraft 不再猜测命令 token**：仅保留 `/skill <name>` 识别（无歧义前缀）；`/random ordinary text` 和 `/model grok` 等任意文本不再被误包装为命令 token。命令 token 恢复需通过显式元数据。
2. **PersistedConversationTab 新增可选 token 字段**：`token?: { kind: "skill" | "command"; name: string }`，`normalizeConversationWorkspace` 验证合法 token 并丢弃非法/空名称。
3. **captureActiveConversationRuntime 保存 token 元数据**：`updateConversationTab` patch 包含 `token: this.composerSlashToken ?? undefined`。
4. **restoreActiveConversationRuntime 使用显式 token 元数据**：`applyComposerCanonicalDraft(draft, activeTab.token)` — 有元数据时直接使用，无元数据时回退到 `parseComposerSlashDraft`。
5. **日志恢复**：HEAD 版本完整恢复，追加本轮记录。
6. **预览图清理**：删除仓根 `.slash-token-preview.png`。

## 反向验证
临时恢复「按文本猜 token」的旧逻辑 → 新增 `/random ordinary text` 和 `/model grok` 测试红灯；还原后全绿（59/59）。

## 测试结果
- 定向：77 tests passed（3 files）
- 全量：回 baseline 验证 → 364+ → 0 skipped

## 完成条件核对
1. `/random ordinary text` 永不包装 — 测试新增验证
2. 显式 skill/command token 元数据在标签切换和持久化后正确恢复 — 新增 conversation-tabs 测试
3. 视觉指纹 273dcffc5d… 保持 — 未修改 composer-view/styles.css/composer-view.test
4. 日志删除数 0 — `git diff --numstat` 验证
5. 预览图不存在 — `test ! -e .slash-token-preview.png` 验证

---

## 本轮（token 恢复三漏洞 2026-07-31 15:46）
- 基线：28 files / 372 tests / 0 skipped；三文件定向 77 pass；指纹 273dcffc5d… 保持
- 目标：修 3 个漏洞——无元数据 `/skill` 被包装、非法名称被接受、元数据与 draft 不一致仍显示 token
- 顺序：纯函数判定红灯 → 实现恢复判定 → 收紧 normalize → view 接线 → 反向 → 全量
- 最大风险：修“不一致即丢 token”时吞字/改字；或收紧名称规则误伤合法 skill 名

## 完成（token 恢复三漏洞 2026-07-31 15:49）
1. 红灯 14 fail：restoreComposerSlashDraft 缺失 + /skill 无元数据仍包装 + normalize 接受坏名称
2. 新增纯函数 `restoreComposerSlashDraft(raw, explicitToken?)`：无元数据一律普通文本；元数据须合法（kind + `/^[a-z0-9][a-z0-9._-]*$/i`）且 draft 等于规范前缀或前缀+单空格；不一致保留原文逐字
3. `parseComposerSlashDraft` 收口为 `restoreComposerSlashDraft(raw, null)`，删除 /skill 文本推断
4. `normalizeConversationWorkspace` 用 SLASH_TOKEN_NAME_PATTERN 运行时校验；`bad name`/`../leader`/`/leader`/空/纯空格/` lead:er `/` leader `/未知 kind/非字符串 name 全部丢弃且 workspace+draft 保留
5. view.ts `applyComposerCanonicalDraft` 只调用 restoreComposerSlashDraft，先验证后显示，禁止先显示再检查
6. 反向验证 1：放宽为 `name.trim()` → ` leader ` 被接受（1 红）；还原严格版 57 绿
7. 反向验证 2：临时恢复 /skill 文本推断 → 1 红；还原 22 绿
8. verify：28 files / 392 tests（>372）/ 0 skipped；typecheck+build+diff-check 绿；指纹 273dcffc5d… 保持
