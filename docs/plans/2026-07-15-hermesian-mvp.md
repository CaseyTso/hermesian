# Hermesian Obsidian 插件实施计划

## Summary

从零构建桌面版 Obsidian 社区插件 `hermesian`。插件通过官方 ACP TypeScript SDK 启动并连接本地 `hermes acp`，在右侧栏提供流式对话、Markdown 选区上下文、工具活动和写入前 diff 审批。

## File Structure

| 文件 | 用途 | 操作 |
|---|---|---|
| `manifest.json` | Obsidian 插件元数据 | create |
| `package.json` | scripts 与依赖 | create |
| `tsconfig.json` | TypeScript 配置 | create |
| `esbuild.config.mjs` | Obsidian bundle | create |
| `styles.css` | 侧栏、消息、diff 样式 | create |
| `src/main.ts` | 插件入口与生命周期 | create |
| `src/settings.ts` | 设置模型与设置页 | create |
| `src/types.ts` | UI/选区/ACP 状态类型 | create |
| `src/selection-context.ts` | 选区采集和 prompt 构建 | create |
| `src/vault-files.ts` | Vault 路径保护与 fs 回调 | create |
| `src/acp-client.ts` | ACP 进程、连接、会话和事件 | create |
| `src/view.ts` | ItemView 聊天和审批 UI | create |
| `tests/selection-context.test.ts` | 选区 prompt 测试 | create |
| `tests/vault-files.test.ts` | 路径保护测试 | create |
| `scripts/acp-smoke.mjs` | 真实 Hermes ACP 烟雾测试 | create |
| `scripts/deploy.mjs` | 构建产物部署并 merge 启用列表 | create |
| `README.md` | 安装、使用和安全说明 | create |

## Tasks

### Task 1：项目骨架
- **Files:** manifest、package、tsconfig、esbuild、styles
- **What:** 建立 desktop-only Obsidian 插件构建结构。
- **Test:** 依赖安装后 `npm run typecheck` 与空插件 build 成功。
- **Dependencies:** 无。

### Task 2：选区与 Vault 安全层
- **Files:** `src/types.ts`、`src/selection-context.ts`、`src/vault-files.ts`、对应测试
- **What:** 采集活动 Markdown 选区，生成上下文 prompt；保护所有 Vault 路径。
- **Test:** Vitest 覆盖无选区、行号转换、context clipping、路径穿越。
- **Dependencies:** Task 1。

### Task 3：ACP 客户端
- **Files:** `src/acp-client.ts`
- **What:** 使用官方 SDK 启动 Hermes、initialize/new session、流式更新、取消、权限与 fs handlers。
- **Test:** TypeScript 通过，真实 ACP smoke 能建立 session 并完成 prompt。
- **Dependencies:** Task 1、2。

### Task 4：Obsidian 侧边栏
- **Files:** `src/view.ts`、`styles.css`
- **What:** 原生 ItemView 渲染聊天、选区 chip、工具状态和审批 diff。
- **Test:** build 通过；DOM 逻辑不含未处理 Promise；审批 Promise 可 resolve/cancel。
- **Dependencies:** Task 2、3。

### Task 5：插件入口与设置
- **Files:** `src/main.ts`、`src/settings.ts`
- **What:** 注册视图、ribbon、命令、设置和 unload cleanup。
- **Test:** typecheck/build；manifest desktop-only。
- **Dependencies:** Task 3、4。

### Task 6：部署与集成验证
- **Files:** deploy script、README
- **What:** 部署到目标 Vault，merge `community-plugins.json`，reload 并检查错误。
- **Test:** 产物存在、ID 已启用、`hermes acp --check`、ACP smoke、Obsidian CLI 检查。
- **Dependencies:** 全部。

## Global Constraints

- 不覆盖用户现有社区插件启用列表。
- 不写入或复制 Hermes credentials。
- 不使用 `hermes acp --cwd`；cwd 通过 spawn 和 ACP session 传入。
- ACP permission response 必须使用 `{ outcome: { outcome: "selected", optionId } }`。
- `fs/read_text_file` 返回 `{ content }`。
- MVP 不实现 CodeMirror inline decoration；先交付侧栏 diff approval。
