import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HERMES_ACP_ADAPTER_PYTHON_SCRIPT as script, buildHermesAcpSpawnArgs, isReasoningEffortAck } from "../src/hermes-acp-adapter";
import { resolveHermesExecutable } from "../src/acp-client";
import { resolveHermesPythonCommand } from "../src/hermes-model-catalog";

let python: ReturnType<typeof resolveHermesPythonCommand> | undefined;
try { python = resolveHermesPythonCommand(resolveHermesExecutable("")); } catch { /* Optional installed-source suite. */ }

const ack = { _meta: { hermesian_version: 1, config_id: "hermesian:reasoning_effort", effort: "high", applied: true } };
describe("Hermesian adapter protocol", () => {
  it("isolates Python imports and preserves original CLI arguments", () => {
    expect(buildHermesAcpSpawnArgs({ executable: "python", argsPrefix: ["-u"] }, ["--profile", "work", "acp", "--accept-hooks"]))
      .toEqual({ command: "python", args: ["-u", "-I", "-c", script, "--profile", "work", "acp", "--accept-hooks"] });
  });
  it("requires an exact versioned applied acknowledgment", () => {
    expect(isReasoningEffortAck(ack, "high")).toBe(true);
    for (const response of [null, {}, { configOptions: [] }, { _meta: { ...ack._meta, applied: false } },
      { _meta: { ...ack._meta, hermesian_version: 2 } }, { _meta: { ...ack._meta, config_id: "other" } }]) {
      expect(isReasoningEffortAck(response, "high")).toBe(false);
    }
    expect(isReasoningEffortAck(ack, "low")).toBe(false);
  });
});

/** Real Hermes classes/schema; replace only the model-executing body and persistence with no-I/O doubles. */
const integration = String.raw`
import asyncio, json, sys, types, threading
from pathlib import Path
sys.argv = ["hermes"]
import hermes_cli.main as cli
import acp_adapter.server as server
from acp_adapter.session import SessionState
from hermes_cli.config import load_config_readonly
import hermes_constants as hc
from acp.exceptions import RequestError

# No CLI startup/hooks/model call: retain the real server/schema but stub the execution boundary.
original_calls = []
cli.cmd_acp = lambda args: original_calls.append(args)
native = server.HermesACPAgent
native_turn = native._run_agent_turn

def fake_turn(self, *, state, session_id, **kwargs):
    result = hc.resolve_reasoning_config(load_config_readonly(), state.agent.model)
    if kwargs.get("fail"):
        raise RuntimeError("synthetic turn failure")
    return result
native._run_agent_turn = fake_turn
exec(json.loads(sys.stdin.read()), {"__name__": "adapter_test"})
cli.cmd_acp("sentinel-native-args")
assert original_calls == ["sentinel-native-args"]

class Lock:
    def __init__(self): self.held = False
    def __enter__(self): self.held = True
    def __exit__(self, *args): self.held = False
class DummyAgent:
    def __init__(self, lock):
        self.model = "test-model"
        self.lock = lock
        self._reasoning = None
    @property
    def reasoning_config(self): return self._reasoning
    @reasoning_config.setter
    def reasoning_config(self, value): self._reasoning = value

states = {}
for sid in ("a", "b"):
    lock = Lock()
    states[sid] = SessionState(session_id=sid, agent=DummyAgent(lock), runtime_lock=lock)
saved = []
manager = types.SimpleNamespace(get_session=lambda sid: states.get(sid), save_session=lambda sid: saved.append(sid))
agent = server.HermesACPAgent(session_manager=manager)

async def apply(sid, effort):
    response = await agent.set_config_option("hermesian:reasoning_effort", sid, effort)
    wire = response.model_dump(by_alias=True)
    assert wire["_meta"] == {"hermesian_version": 1, "config_id": "hermesian:reasoning_effort", "effort": effort, "applied": True}
    return wire

async def rejected(sid, effort):
    try:
        await apply(sid, effort)
        raise AssertionError("must reject")
    except RequestError:
        pass

async def exercise():
    await rejected("missing", "high")
    await rejected("a", "bogus")
    states["a"].is_running = True
    await rejected("a", "high")
    states["a"].is_running = False
    await apply("a", "high")
    assert states["a"].agent.reasoning_config == {"enabled": True, "effort": "high"}
    assert states["b"].agent.reasoning_config is None
    await apply("b", "default")
    # Real read-only loader + model override, NOT a stub that ignores cfg.
    assert states["b"].agent.reasoning_config == {"enabled": True, "effort": "low"}
    assert agent._run_agent_turn(state=states["a"], session_id="a") == {"enabled": True, "effort": "high"}
    assert agent._run_agent_turn(state=states["b"], session_id="b") == {"enabled": True, "effort": "low"}
    try:
        agent._run_agent_turn(state=states["a"], session_id="a", fail=True)
    except RuntimeError:
        pass
    assert hc.resolve_reasoning_config(load_config_readonly(), "test-model") == {"enabled": True, "effort": "low"}
    await apply("a", "none")
    assert agent._run_agent_turn(state=states["a"], session_id="a") == {"enabled": False}
    await apply("a", "default")
    assert states["a"].agent.reasoning_config == {"enabled": True, "effort": "low"}
    states["a"].agent = None
    await rejected("a", "high")
    assert saved == [], "plugin setting must not persist Hermes transcripts/config"
    # Unrelated native options still pass through the original implementation.
    await agent.set_config_option("unrelated", "b", "value")
    assert states["b"].config_options["unrelated"] == "value"
    assert saved == ["b"]
asyncio.run(exercise())
print("REAL_TYPES_AND_TURN_BOUNDARY_OK")
`;

it.skipIf(!python)("uses real installed ACP types/defaults/turn boundary with synthetic state only", () => {
  const home = mkdtempSync(join(tmpdir(), "hermesian-adapter-test-"));
  const config = join(home, "config.yaml");
  const contents = "agent:\n  reasoning_effort: medium\n  reasoning_overrides:\n    test-model: low\n";
  writeFileSync(config, contents);
  try {
    const result = spawnSync(python!.executable, [...python!.argsPrefix, "-I", "-c", integration], {
      input: JSON.stringify(script), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HERMES_HOME: home, HERMES_PROFILE: "" },
    });
    expect(result.stderr, "installed-source integration").not.toContain("Traceback");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REAL_TYPES_AND_TURN_BOUNDARY_OK");
    expect(readFileSync(config, "utf8")).toBe(contents);
    expect(existsSync(join(home, "state.db"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.skipIf(!python)("cannot import malicious vault/PYTHONPATH modules before native bootstrap", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hermesian-import-test-"));
  const marker = join(cwd, "executed");
  for (const module of ["hermes_cli", "hermes_bootstrap", "hermes_constants", "json"]) {
    writeFileSync(join(cwd, `${module}.py`), `open(${JSON.stringify(marker)}, 'w').write('unsafe')\nraise RuntimeError('untrusted import')\n`);
  }
  try {
    // Execute production argument construction, but --version makes no model/session requests.
    const launch = buildHermesAcpSpawnArgs(python!, ["acp", "--version"]);
    const result = spawnSync(launch.command, launch.args, { cwd, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HERMES_HOME: cwd, HERMES_PROFILE: "", PYTHONPATH: cwd, PYTHONHOME: cwd } });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
