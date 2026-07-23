# Hermesian Obsidian Native UI Polish Plan

## Summary

在不改变 ACP/session 行为的前提下，以 Obsidian semantic tokens 重构 Hermesian 侧栏的视觉层级，精修 Header、Conversation Tabs、消息、Activity 和 Composer，并补齐 loading、focus、ARIA 与 reduced-motion 状态。先部署可回滚预览，用户认可后再做完整工程验证。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `styles.css` | 修改 | 局部 design tokens、组件视觉、响应式、焦点和 reduced-motion |
| `src/view.ts` | 修改 | 暴露 client loading class，补充 status/error ARIA |
| `docs/design/2026-07-21-obsidian-native-ui-polish-design.md` | 新增 | 已批准的视觉设计边界 |
| `docs/plans/2026-07-21-obsidian-native-ui-polish.md` | 新增 | 实施和验收步骤 |

## Tasks

### Task 1：建立局部视觉 tokens 与交互基线

- **文件**：`styles.css`
- **实现**：在 `.hermesian-view` 定义 surface、accent、radius、spacing、motion tokens；统一 clickable controls 的 hover、active、disabled 和 focus-visible；增加 reduced-motion override。
- **完成条件**：不再依赖组件内固定品牌色，规则只作用于 Hermesian 根节点。

### Task 2：精修 Header、Tabs 与状态

- **文件**：`styles.css`、`src/view.ts`
- **依赖**：Task 1
- **实现**：压缩顶部高度，重做活动/working/loading 标签状态；为 connection status 添加 status semantics；loading class 只读取既有 `clientLoadingTabs`。
- **完成条件**：窄侧栏可用，标签状态不只由颜色表达，不改变切换逻辑。

### Task 3：精修消息、Activity 与 Composer

- **文件**：`styles.css`、`src/view.ts`
- **依赖**：Task 1
- **实现**：重做 user/assistant 层级、Thinking/Tool activity card、context chips、输入卡和唯一主操作；错误系统消息使用 alert semantics。
- **完成条件**：浅/深主题都只依赖 semantic tokens，Composer 在约 300–480px 宽度不横向溢出。

### Task 4：部署视觉预览

- **文件**：构建产物与测试 vault 插件目录
- **依赖**：Tasks 1–3
- **实现**：执行构建与 `npm run deploy`，逐文件比对 `main.js`、`manifest.json`、`styles.css`，通过 Advanced URI reload Obsidian。
- **完成条件**：部署产物与源码构建一致，用户可在现有 vault 直接检查。

### Task 5：认可后完整验证

- **依赖**：用户确认视觉方向
- **实现**：按反馈做最后一轮视觉调整；随后运行 test、typecheck、build、diff check。
- **完成条件**：最终源码快照通过完整验证；未经明确要求不 commit/push。

## Constraints

- 不新增依赖、字体或图片资产。
- 不修改 ACP、conversation workspace、持久化 schema 或并发控制。
- 不为追求品牌感覆盖 Obsidian 主题变量。
- 用户确认视觉前不提交；创意阶段仅做预览构建和部署。
