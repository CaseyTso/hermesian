import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDebugLogger,
  safeErrorFields,
  type SafeDebugFields,
} from "../src/debug-logger";

describe("createDebugLogger", () => {
  let debugSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    debugSpy = vi.fn();
    warnSpy = vi.fn();
    errorSpy = vi.fn();
    (console as unknown as Record<string, unknown>).debug = debugSpy;
    (console as unknown as Record<string, unknown>).warn = warnSpy;
    (console as unknown as Record<string, unknown>).error = errorSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("disabled logger", () => {
    it("produces zero output for debug", () => {
      const logger = createDebugLogger(false);
      logger.debug("client.connect.start", { operation: "connect" });
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("produces zero output for warn", () => {
      const logger = createDebugLogger(false);
      logger.warn("client.process.exit", { code: 1 });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("produces zero output for error", () => {
      const logger = createDebugLogger(false);
      logger.error("session.operation.start", { operation: "load" });
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("enabled logger", () => {
    it("logs debug events to console.debug", () => {
      const logger = createDebugLogger(true);
      logger.debug("client.connect.start", { operation: "connect" });
      expect(debugSpy).toHaveBeenCalledOnce();
      const call = debugSpy.mock.calls[0];
      expect(call[0]).toBe("[hermesian]");
      expect(call[1]).toEqual({ event: "client.connect.start", operation: "connect" });
    });

    it("logs warn events to console.warn", () => {
      const logger = createDebugLogger(true);
      logger.warn("client.process.exit", { signal: "SIGKILL" });
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("logs error events to console.error", () => {
      const logger = createDebugLogger(true);
      logger.error("session.operation.finish", { durationMs: 1500 });
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("only includes allowlisted fields in the payload", () => {
      const logger = createDebugLogger(true);
      logger.debug("client.connect.start", {
        operation: "connect",
        prompt: "secret text",
        sessionId: "sess-123",
        vaultPath: "/home/user/vault",
      } as unknown as SafeDebugFields);

      expect(debugSpy).toHaveBeenCalledOnce();
      const payload = debugSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.operation).toBe("connect");
      expect(payload).not.toHaveProperty("prompt");
      expect(payload).not.toHaveProperty("sessionId");
      expect(payload).not.toHaveProperty("vaultPath");
    });

    it("rejects non-primitive field values", () => {
      const logger = createDebugLogger(true);
      logger.debug("controller.tab.operation", {
        operation: { nested: "object" },
      } as unknown as SafeDebugFields);

      expect(debugSpy).toHaveBeenCalledOnce();
      const payload = debugSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("operation");
    });

    it("accepts null and undefined field values", () => {
      const logger = createDebugLogger(true);
      logger.debug("controller.transition.invalidated", {
        reason: null,
        generation: undefined,
      } as unknown as SafeDebugFields);

      expect(debugSpy).toHaveBeenCalledOnce();
      const payload = debugSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.reason).toBeNull();
    });

    it("works without fields", () => {
      const logger = createDebugLogger(true);
      logger.debug("client.connect.ready");
      expect(debugSpy).toHaveBeenCalledOnce();
      const payload = debugSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload).toEqual({ event: "client.connect.ready" });
    });
  });
});

describe("safeErrorFields", () => {
  it("extracts only error name from an Error object", () => {
    const error = new Error("Failed to read /home/user/secret.txt");
    error.name = "EACCES";
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ errorCode: "EACCES" });
    expect(fields).not.toHaveProperty("message");
  });

  it("returns empty object for non-Error values", () => {
    expect(safeErrorFields("string error")).toEqual({});
    expect(safeErrorFields(null)).toEqual({});
    expect(safeErrorFields(42)).toEqual({});
  });

  it("preserves the default error name when none is set", () => {
    const error = new Error("some message");
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ errorCode: "Error" });
  });
});
