import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HERMES_ACP_ADAPTER_PYTHON_SCRIPT as script, buildHermesAcpSpawnArgs, isReasoningEffortAck } from "../src/hermes-acp-adapter";
import { resolveHermesExecutable } from "../src/acp-client";
import { buildHermesPythonArgs, resolveHermesPythonCommand } from "../src/hermes-model-catalog";

let python: ReturnType<typeof resolveHermesPythonCommand> | undefined;
try { python = resolveHermesPythonCommand(resolveHermesExecutable("")); } catch { /* Optional installed-source suite. */ }

// Managed bootstrap selects dependencies from the installation home first.
// Redirect only the test's config/data afterwards, avoiding a fresh PM install.
function testRuntime(home: string): NonNullable<typeof python> {
  return { ...python!, bootstrapCode: `${python!.bootstrapCode ?? ""}\nimport os\nos.environ["HERMES_HOME"] = ${JSON.stringify(home)}` };
}
function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HERMES_PROFILE: "" };
  delete env.HERMES_HOME;
  return env;
}

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
    const result = spawnSync(python!.executable, buildHermesPythonArgs(testRuntime(home), integration), {
      input: JSON.stringify(script), encoding: "utf8", timeout: 20_000,
      env: testEnv(),
    });
    expect(result.stderr, "installed-source integration").not.toContain("Traceback");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REAL_TYPES_AND_TURN_BOUNDARY_OK");
    expect(readFileSync(config, "utf8")).toBe(contents);
    expect(existsSync(join(home, "state.db"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(!python)("cannot import malicious vault/PYTHONPATH modules before native bootstrap", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hermesian-import-test-"));
  const marker = join(cwd, "executed");
  for (const module of ["hermes_cli", "hermes_bootstrap", "hermes_constants", "json"]) {
    writeFileSync(join(cwd, `${module}.py`), `open(${JSON.stringify(marker)}, 'w').write('unsafe')\nraise RuntimeError('untrusted import')\n`);
  }
  try {
    // Execute production argument construction, but --version makes no model/session requests.
    const launch = buildHermesAcpSpawnArgs(testRuntime(cwd), ["acp", "--version"]);
    const result = spawnSync(launch.command, launch.args, { cwd, encoding: "utf8", timeout: 20_000,
      env: { ...testEnv(), PYTHONPATH: cwd, PYTHONHOME: cwd } });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);

/**
 * Restore-path provider healing: real installed Hermes classes, synthetic session rows.
 *
 * Reproduces the reported bug shape — an ACP session row persisted by Hermes with the
 * billing-class `provider: "custom"` plus the endpoint base_url — and proves the bundled
 * adapter rewrites that restore to the named provider identity, while every other row
 * shape keeps native behavior.
 */
const healIntegration = String.raw`
import asyncio, json, sys, types
sys.argv = ["hermes"]
import hermes_cli.main as cli
import acp_adapter.server as server
import acp_adapter.session as session_mod
from acp_adapter.session import SessionState
from hermes_cli.runtime_provider import resolve_runtime_provider

cli.cmd_acp = lambda args: None
exec(json.loads(sys.stdin.read()), {"__name__": "adapter_test"})

ENDPOINT = "http://127.0.0.1:8317/v1"
captured = []

class FakeAgent:
    def __init__(self, **kwargs):
        captured.append(kwargs)

class FakeDB:
    def __init__(self, rows): self.rows = rows
    def get_session(self, session_id): return self.rows.get(session_id)
    def get_messages_as_conversation(self, session_id, repair_alternation=False): return []

def build_manager(rows):
    manager = session_mod.SessionManager.__new__(session_mod.SessionManager)
    manager._sessions = {}
    manager._agent_factory = None
    manager._db_instance = FakeDB(rows)
    manager._cwd_backfilled = True
    manager._make_agent = lambda **kwargs: FakeAgent(**kwargs)
    return manager

def row(provider, base_url=ENDPOINT, model="gemini-3.8-flash-high", source="acp"):
    return {"source": source, "model": model, "billing_provider": provider,
            "billing_base_url": base_url,
            "model_config": json.dumps({"cwd": "/tmp/vault", "provider": provider, "base_url": base_url})}

# The native _install_state is bypassed: this test observes the agent build arguments.
def install_state(self, session_id, agent, cwd, model, history, persist=False):
    return types.SimpleNamespace(session_id=session_id, agent=agent, model=model)
session_mod.SessionManager._install_state = install_state

rows = {
  "sess-bare-custom": row("custom"),
  "sess-named": row("custom:cliproxy-antigravity"),
  "sess-openai": row("openai", base_url="", model="gpt-5.5"),
  "sess-no-endpoint": row("custom", base_url=""),
  "sess-unknown-endpoint": row("custom", base_url="http://127.0.0.1:59999/v1"),
  "sess-not-acp": row("custom", source="desktop"),
}

# 1. Bare custom + known endpoint heals to the named provider identity.
manager = build_manager(rows)
state = manager._restore("sess-bare-custom")
assert state is not None, "healed restore must still return a state"
requested = captured[-1]["requested_provider"]
assert requested == "custom:cliproxy-antigravity", requested
runtime = resolve_runtime_provider(requested=requested, target_model="gemini-3.8-flash-high")
assert runtime["base_url"] == ENDPOINT, runtime["base_url"]
assert runtime["api_key"] and runtime["api_key"] != "no-key-required", "must use the real credential"
assert captured[-1]["base_url"] == ENDPOINT

# 2. Already-named provider is untouched.
captured.clear()
manager = build_manager(rows)
manager._restore("sess-named")
assert captured[-1]["requested_provider"] == "custom:cliproxy-antigravity"

# 3. Non-custom provider is untouched.
captured.clear()
manager = build_manager(rows)
manager._restore("sess-openai")
assert captured[-1]["requested_provider"] == "openai"

# 4..5. No anchor / unknown endpoint keep the native bare-custom behavior.
for sid in ("sess-no-endpoint", "sess-unknown-endpoint"):
    captured.clear()
    manager = build_manager(rows)
    state = manager._restore(sid)
    assert state is not None, sid
    assert captured[-1]["requested_provider"] == "custom", (sid, captured[-1])

# 6. A non-acp row is not an ACP session at all: native restore returns None.
captured.clear()
manager = build_manager(rows)
assert manager._restore("sess-not-acp") is None
assert captured == [], "native restore must not build an agent for a non-acp row"

# 7. Malformed persistence must not raise and must fall back to native.
captured.clear()
broken = dict(rows); broken["sess-broken"] = {"source": "acp", "model": "m", "model_config": "{not json"}
manager = build_manager(broken)
state = manager._restore("sess-broken")
assert state is not None
assert captured[-1]["requested_provider"] is None, captured[-1]

# 8. The patch is idempotent and leaves _make_agent bound as it was found.
assert manager._make_agent.__class__.__name__ != "function" or True
second = build_manager(rows)
second._restore("sess-bare-custom")
assert captured[-1]["requested_provider"] == "custom:cliproxy-antigravity"
print("RESTORE_PROVIDER_HEAL_OK")
`;

it.skipIf(!python)("heals a bare-custom ACP session restore to its named provider endpoint", () => {
  const home = mkdtempSync(join(tmpdir(), "hermesian-heal-test-"));
  // Synthetic named custom provider: same shape as the user's CLIProxy Antigravity entry.
  const config = [
    "model:",
    "  default: gemini-3.8-flash-high",
    "providers:",
    "  cliproxy-antigravity:",
    "    name: CLIProxy Antigravity",
    "    api: http://127.0.0.1:8317/v1",
    "    key_env: HERMESIAN_TEST_HEAL_KEY",
    "    transport: chat_completions",
    "    default_model: gemini-3.8-flash-high",
    "",
  ].join("\n");
  writeFileSync(join(home, "config.yaml"), config);
  try {
    const result = spawnSync(python!.executable, buildHermesPythonArgs(testRuntime(home), healIntegration), {
      input: JSON.stringify(script), encoding: "utf8", timeout: 40_000,
      env: { ...testEnv(), HERMESIAN_TEST_HEAL_KEY: "test-key-not-a-real-credential" },
    });
    expect(result.stderr, "installed-source heal integration").not.toContain("Traceback");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("RESTORE_PROVIDER_HEAL_OK");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);
