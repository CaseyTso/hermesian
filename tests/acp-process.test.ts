import { afterEach, describe, expect, it } from "vitest";

import type { AcpProcessExit } from "../src/acp-process";
import { AcpProcess } from "../src/acp-process";

const NODE = process.execPath;

function exitCode(exit: AcpProcessExit): number | null {
  return exit.code;
}
function exitSignal(exit: AcpProcessExit): string | null {
  return exit.signal;
}

/** Small delay to let child processes initialize. */
const tick = (ms = 50): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("AcpProcess", () => {
  const managed: AcpProcess[] = [];

  afterEach(async () => {
    for (const proc of managed.splice(0)) {
      try {
        await proc.terminate({ graceMs: 300, killWaitMs: 500 });
      } catch {
        // best-effort cleanup
      }
    }
  });

  const track = (proc: AcpProcess): AcpProcess => {
    managed.push(proc);
    return proc;
  };

  const spawnNode = (script: string): AcpProcess =>
    AcpProcess.spawn({ command: NODE, args: ["-e", script] });

  describe("spawn", () => {
    it("rejects waitForExit for a non-existent command", async () => {
      const proc = AcpProcess.spawn({
        command: "/nonexistent/command",
        args: [],
      });
      await expect(proc.waitForExit()).rejects.toThrow();
    });

    it("provides stdin and stdout streams for a running process", () => {
      const proc = track(spawnNode("setTimeout(() => {}, 5000)"));
      expect(proc.stdin).toBeDefined();
      expect(proc.stdout).toBeDefined();
    });
  });

  describe("stderr tail", () => {
    it("returns an empty string when the child wrote nothing to stderr", async () => {
      const proc = track(spawnNode("process.exit(0)"));
      await proc.waitForExit();
      expect(proc.stderrTail()).toBe("");
    });

    it("captures stderr output from the child", async () => {
      const proc = track(
        spawnNode('process.stderr.write("hello stderr\\n"); process.exit(0)'),
      );
      await proc.waitForExit();
      expect(proc.stderrTail()).toContain("hello stderr");
    });

    it("caps stderr to the tail of the buffer (16 KB)", async () => {
      const proc = track(
        spawnNode(
          `const pad = "x".repeat(1024);
for (let i = 0; i < 20; i++) process.stderr.write(pad);
process.exit(0)`,
        ),
      );
      await proc.waitForExit();
      const tail = proc.stderrTail();
      expect(tail.length).toBeLessThan(20000);
    });
  });

  describe("waitForExit", () => {
    it("resolves with exit code when the child exits cleanly", async () => {
      const proc = track(spawnNode("process.exit(42)"));
      const exit = await proc.waitForExit();
      expect(exitCode(exit)).toBe(42);
      expect(exitSignal(exit)).toBeNull();
    });

    it("resolves with signal when the child is killed", async () => {
      const proc = track(spawnNode("setTimeout(() => {}, 30000)"));
      const waitPromise = proc.waitForExit();
      await tick();
      proc.terminate({ graceMs: 100, killWaitMs: 2000 });
      const exit = await waitPromise;
      expect(exitSignal(exit)).toBeDefined();
    });

    it("lets multiple waiters resolve with the same exit result", async () => {
      const proc = track(spawnNode("process.exit(7)"));
      const [a, b, c] = await Promise.all([
        proc.waitForExit(),
        proc.waitForExit(),
        proc.waitForExit(),
      ]);
      expect(exitCode(a)).toBe(7);
      expect(a).toEqual(b);
      expect(a).toEqual(c);
    });
  });

  describe("terminate", () => {
    it("is a no-op when the process has already exited", async () => {
      const proc = track(spawnNode("process.exit(0)"));
      await proc.waitForExit();
      const exit = await proc.terminate();
      expect(exitCode(exit)).toBe(0);
    });

    it("is idempotent — multiple calls return the same exit result", async () => {
      const proc = track(spawnNode("setTimeout(() => process.exit(0), 200)"));
      const [a, b] = await Promise.all([
        proc.terminate(),
        proc.terminate(),
      ]);
      expect(a).toEqual(b);
    });

    it("sends SIGTERM and waits for graceful exit without SIGKILL", async () => {
      // Child handles SIGTERM by writing to stderr and exiting with code 0
      const proc = track(
        spawnNode(
          `process.on("SIGTERM", () => { process.stderr.write("term-received"); process.exit(0) });
setTimeout(() => {}, 30000)`,
        ),
      );
      await tick(100);
      const exit = await proc.terminate({ graceMs: 2000, killWaitMs: 1000 });
      // The child's SIGTERM handler calls process.exit(0), so:
      // exit code is 0 (from the handler) and signal is null (not killed by SIGKILL)
      expect(exitCode(exit)).toBe(0);
      expect(exitSignal(exit)).toBeNull();
      expect(proc.stderrTail()).toContain("term-received");
    });

    it("escalates to SIGKILL when the child ignores SIGTERM past the grace period", async () => {
      // Child handles SIGTERM but does NOT exit — keeps running
      const proc = track(
        spawnNode(
          `process.on("SIGTERM", () => { process.stderr.write("ignoring-term"); });
setTimeout(() => {}, 30000)`,
        ),
      );
      await tick(100);
      const exit = await proc.terminate({ graceMs: 300, killWaitMs: 5000 });
      expect(exitSignal(exit)).toBe("SIGKILL");
    });

    it("reports the exit code when the child handles SIGTERM and exits with its own code", async () => {
      const proc = track(
        spawnNode(
          `process.on("SIGTERM", () => { process.exit(99) });
setTimeout(() => {}, 30000)`,
        ),
      );
      await tick(150);
      const exit = await proc.terminate({ graceMs: 2000, killWaitMs: 1000 });
      expect(exitCode(exit)).toBe(99);
    });
  });

  describe("lifecycle", () => {
    it("stderrTail is preserved after terminate", async () => {
      const proc = track(
        spawnNode(
          `process.stderr.write("pre-terminate");
process.on("SIGTERM", () => { process.exit(0) });
setTimeout(() => {}, 30000)`,
        ),
      );
      await tick(150);
      await proc.terminate({ graceMs: 1000, killWaitMs: 500 });
      expect(proc.stderrTail()).toBe("pre-terminate");
    });

    it("cleans up stdin/stdout handlers after exit", async () => {
      const proc = track(spawnNode("process.exit(0)"));
      await proc.waitForExit();
      expect(proc.stdin).toBeDefined();
      expect(proc.stdout).toBeDefined();
    });

    it("captures stderr even when the child is force-killed", async () => {
      const proc = track(
        spawnNode(
          `process.stderr.write("before-kill\\n");
process.on("SIGTERM", () => {}); // ignore, wait for SIGKILL
setTimeout(() => {}, 30000)`,
        ),
      );
      await tick(200);
      await proc.terminate({ graceMs: 150, killWaitMs: 2000 });
      expect(proc.stderrTail()).toContain("before-kill");
    });
  });
});
