import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import {
  automaticVaultEditApproval,
  buildHermesAcpArgs,
  HermesAcpClient,
} from "../src/acp-client";

function permissionRequest(
  content: RequestPermissionRequest["toolCall"]["content"],
  kind: NonNullable<RequestPermissionRequest["toolCall"]["kind"]> = "edit",
): RequestPermissionRequest {
  return {
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ],
    sessionId: "session",
    toolCall: {
      content,
      kind,
      toolCallId: "tool",
    },
  };
}

describe("buildHermesAcpArgs", () => {
  it("selects the default profile through Hermes' global CLI flag", () => {
    expect(buildHermesAcpArgs("default", true)).toEqual([
      "--profile",
      "default",
      "acp",
      "--accept-hooks",
    ]);
  });

  it("omits profile and startup-hook flags when they are disabled", () => {
    expect(buildHermesAcpArgs("  ", false)).toEqual(["acp"]);
  });

  it("trims named profiles", () => {
    expect(buildHermesAcpArgs(" coding_agent ", false)).toEqual([
      "--profile",
      "coding_agent",
      "acp",
    ]);
  });
});

describe("HermesAcpClient session safety", () => {
  it("rejects session history loads while a prompt is active", async () => {
    const client = new HermesAcpClient({
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: () => ({
        acceptHooks: true,
        autoApproveVaultEdits: true,
        debugLogging: false,
        hermesExecutable: "hermes",
        profile: "default",
        reasoningEffort: "default",
      }),
      vaultPath: "/tmp/hermesian-test-vault",
    });
    Reflect.set(client, "busy", true);
    Reflect.set(client, "connectPromise", Promise.resolve());

    await expect(client.loadSessionHistory("session-b")).rejects.toThrow(
      "Cannot load conversation history while Hermes is responding",
    );
  });

  it("claims the prompt slot before awaiting connection", async () => {
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const client = new HermesAcpClient({
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: () => ({
        acceptHooks: true,
        autoApproveVaultEdits: true,
        debugLogging: false,
        hermesExecutable: "hermes",
        profile: "default",
        reasoningEffort: "default",
      }),
      vaultPath: "/tmp/hermesian-test-vault",
    });
    Reflect.set(client, "connectPromise", pendingConnect);

    const firstPrompt = client.sendPrompt("first");
    await Promise.resolve();
    expect(client.isBusy).toBe(true);
    await expect(client.sendPrompt("second")).rejects.toThrow(
      "Hermes is already processing a prompt",
    );

    resolveConnect();
    await expect(firstPrompt).rejects.toThrow("Hermes ACP session is unavailable");
    expect(client.isBusy).toBe(false);
  });

  it("serializes session operations before awaiting connection", async () => {
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const client = new HermesAcpClient({
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: () => ({
        acceptHooks: true,
        autoApproveVaultEdits: true,
        debugLogging: false,
        hermesExecutable: "hermes",
        profile: "default",
        reasoningEffort: "default",
      }),
      vaultPath: "/tmp/hermesian-test-vault",
    });
    Reflect.set(client, "connectPromise", pendingConnect);

    const firstLoad = client.loadSessionHistory("session-a");
    await Promise.resolve();
    expect(client.isOperating).toBe(true);
    await expect(client.loadSessionHistory("session-b")).rejects.toThrow(
      "Cannot load conversation history while Hermes is responding",
    );
    await expect(client.sendPrompt("blocked")).rejects.toThrow(
      "Hermes is already processing a prompt",
    );

    resolveConnect();
    await expect(firstLoad).rejects.toThrow("Hermes ACP context is unavailable");
    expect(client.isOperating).toBe(false);
  });
});

describe("automaticVaultEditApproval", () => {
  const temporaryVaults: string[] = [];
  const createVault = (): string => {
    const vault = mkdtempSync(join(tmpdir(), "hermesian-permission-"));
    temporaryVaults.push(vault);
    return vault;
  };

  afterEach(() => {
    for (const vault of temporaryVaults.splice(0)) {
      rmSync(vault, { force: true, recursive: true });
    }
  });

  it("automatically approves a verified diff inside the Vault", () => {
    const vault = createVault();
    const response = automaticVaultEditApproval(
      permissionRequest([
        {
          newText: "new",
          oldText: "old",
          path: join(vault, "note.md"),
          type: "diff",
        },
      ]),
      vault,
      true,
    );
    expect(response).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("does not automatically approve a request without a verifiable diff", () => {
    const vault = createVault();
    expect(automaticVaultEditApproval(permissionRequest(null), vault, true)).toBeUndefined();
  });

  it("does not automatically approve a non-edit tool even when it carries a diff", () => {
    const vault = createVault();
    const request = permissionRequest(
      [
        {
          newText: "new",
          path: join(vault, "note.md"),
          type: "diff",
        },
      ],
      "execute",
    );
    expect(automaticVaultEditApproval(request, vault, true)).toBeUndefined();
  });

  it("rejects a diff target outside the Vault boundary", () => {
    const vault = createVault();
    expect(() =>
      automaticVaultEditApproval(
        permissionRequest([
          {
            newText: "new",
            path: join(vault, "..", "outside-note.md"),
            type: "diff",
          },
        ]),
        vault,
        true,
      ),
    ).toThrow(/outside the Obsidian vault/i);
  });
});
