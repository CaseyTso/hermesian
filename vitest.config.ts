import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: [
        "src/conversation-tabs.ts",
        "src/conversation-runtime.ts",
        "src/conversation-controller.ts",
        "src/tab-client-registry.ts",
        "src/acp-process.ts",
        "src/session-state.ts",
        "src/workspace-persistence.ts",
        "src/ui/composer-view.ts",
        "src/ui/message-renderer.ts",
      ],
      thresholds: {
        branches: 75,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
  },
});