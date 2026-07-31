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
