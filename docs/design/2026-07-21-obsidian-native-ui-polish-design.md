# Hermesian Obsidian 原生界面精修设计

## 背景

Hermesian 已具备完整的 ACP 对话、History、并行标签、上下文和权限交互，但当前视觉实现混用了 Obsidian semantic tokens 与固定色值，顶部 chrome、消息卡片和 Composer 的层级偏重，在不同 Obsidian 主题及窄侧栏中缺少一致性。

## 目标

- 保持 Obsidian 原生视觉语言，自动适配浅色、深色及第三方主题。
- 强化对话、活动状态和 Composer 的视觉层级，减少厚重边框与卡片嵌套。
- 让 session loading、working、connected、error 和主操作状态更易辨认。
- 保持键盘可访问性、可见焦点和 reduced-motion 支持。
- 不改变 ACP、session、workspace、turn runtime 或持久化行为。

## 视觉系统

- 字体：继承 Obsidian UI 与正文变量，不加载外部字体。
- 色彩：只使用 Obsidian semantic tokens；浅色 accent surface 使用 `color-mix()` 派生。
- 间距：4 / 8 / 12 / 16px。
- 圆角：6 / 9 / 12px；pill 仅用于标签和上下文 chip。
- 动效：120–160ms，限制为 opacity、color、background、border、box-shadow 和 transform；尊重 `prefers-reduced-motion`。
- 阴影：仅 Composer 和浮层使用两级轻阴影。

## 组件设计

### Header 与 Conversation Tabs

Header 高度收紧至 36px。Logo、标题和连接状态保持一行，操作按钮沿用 Obsidian Lucide 图标。标签栏高度收紧，数字标签改为轻量 pill；活动标签使用 accent tint，working 使用状态点，client loading 使用旋转图标语义。窄侧栏只隐藏状态文字，不移除状态点。

### 消息与 Activity

用户消息右对齐，使用主题 accent 淡色 surface，最大宽度约 86%。Assistant 消息取消整块厚重背景，使用透明内容区与弱分隔，使 Markdown 成为主体。Thinking 与 Tool 统一为紧凑 activity card，状态、图标和标题在同一视觉层级。

### Composer

Composer 保留底部卡片结构，使用主题 surface、轻阴影和 `:focus-within` accent。当前文件与 Selection 统一为 context chips。Model 与 Thinking 是低强调控制；Send 是唯一实心 accent 主操作，Stop 使用语义危险色。Textarea 初始高度收紧到 64px，但保留 vertical resize。

### Accessibility 与状态反馈

所有自定义按钮提供统一 `:focus-visible`。连接状态使用 `role=status`，错误系统消息使用 `role=alert`。颜色之外保留文本、title 或形状信息。切换/初始化中的标签展示 loading 状态。动效在 reduced-motion 下关闭。

## 修改范围

| 文件 | 变更 |
|---|---|
| `styles.css` | semantic tokens、布局、消息、activity、Composer、焦点、动效与 responsive 样式 |
| `src/view.ts` | loading/state class 与必要 ARIA；不改业务逻辑 |

## 验证策略

先部署未提交预览到测试 vault，由用户在实际 Obsidian 主题中检查视觉。视觉认可后再运行 `npm run test`、`npm run typecheck`、`npm run build` 和 `git diff --check`；未经明确要求不提交或推送。
