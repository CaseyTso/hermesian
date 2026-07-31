# BLOCKED

无

## 已解除：真人冷启动
用户 2026-07-30 确认：不开安全模式可正常进入 Obsidian；Hermesian 不再卡住 Vault 启动。
此前自动化侧缺少无 AX 就绪探针，曾记为阻塞；现由真人验收闭环。

## 本轮（tab 延迟）
无。ACP 协议级延迟基准与自动化 gate 均已完成；deploy 三文件一致。
上游 session/new 与 session/load 各约 14s 是 Hermes 侧下限，本轮未改 Hermes Agent。

## 本轮（晚到响应）
无。

## 本轮（aborted transport）
无。

## 本轮（token 误识别 + 日志恢复 + 预览图清理）
无。所有已知问题已修复：未知 `/文字` 不再误包装，HEAD 日志已恢复，预览图已删除。

## 本轮（token 恢复三漏洞）
无。三漏洞已修复：无元数据 `/skill` 不再包装、非法名称全部丢弃、元数据与 draft 不一致时原文逐字保留。
