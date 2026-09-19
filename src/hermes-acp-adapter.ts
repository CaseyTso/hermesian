import type { PythonCommand } from "./hermes-model-catalog";

export const HERMESIAN_REASONING_EFFORT_CONFIG_ID = "hermesian:reasoning_effort";
export const HERMESIAN_REASONING_EFFORT_VERSION = 1;

/** Process-local compatibility bridge; never patches installed files or relocates Hermes data. */
export const HERMES_ACP_ADAPTER_PYTHON_SCRIPT = String.raw`
import sys

# The interpreter is launched with -I: neither vault cwd nor PYTHONPATH may supply imports.
import hermes_bootstrap
hermes_bootstrap.harden_import_path()
if sys.argv and sys.argv[0] == "-c":
    sys.argv[0] = "hermes"

# Native CLI import owns early profile parsing; native main owns hooks and ACP startup.
import hermes_cli.main as cli_main
import contextvars
import hermes_constants

_orig_resolve_reasoning = hermes_constants.resolve_reasoning_config
_turn_reasoning = contextvars.ContextVar("hermesian_turn_reasoning", default=None)

def _resolve_reasoning(cfg=None, model=""):
    explicit = _turn_reasoning.get()
    return dict(explicit) if explicit is not None else _orig_resolve_reasoning(cfg, model)

hermes_constants.resolve_reasoning_config = _resolve_reasoning
_orig_cmd_acp = cli_main.cmd_acp

def _hermesian_cmd_acp(args):
    import acp_adapter.server as server_mod
    from acp.schema import SetSessionConfigOptionResponse
    from acp.exceptions import RequestError
    from hermes_cli.config import load_config_readonly

    original = server_mod.HermesACPAgent
    if not callable(getattr(original, "_run_agent_turn", None)):
        raise RuntimeError("Hermesian thinking adapter: unsupported Hermes turn interface")

    class HermesianACPAgent(original):
        async def set_config_option(self, config_id, session_id, value, **kwargs):
            if config_id != "hermesian:reasoning_effort":
                return await super().set_config_option(config_id, session_id, value, **kwargs)
            if value not in ("default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"):
                raise RequestError(-32602, "Invalid Hermesian reasoning effort")
            state = self.session_manager.get_session(session_id)
            if state is None or getattr(state, "agent", None) is None:
                raise RequestError(-32602, "Hermes session agent is unavailable")
            lock = getattr(state, "runtime_lock", None)
            if lock is None:
                raise RequestError(-32603, "Unsupported Hermes session locking interface")
            with lock:
                if state.is_running:
                    raise RequestError(-32600, "Cannot apply thinking depth during an active turn")
                explicit = None if value == "default" else hermes_constants.parse_reasoning_effort(value)
                applied = (_orig_resolve_reasoning(load_config_readonly(), state.agent.model)
                           if explicit is None else dict(explicit))
                state.agent.reasoning_config = applied
                state._hermesian_reasoning = explicit
            # Desired preference is persisted by Hermesian, not in Hermes config or transcript DB.
            return SetSessionConfigOptionResponse(config_options=[], field_meta={
                "hermesian_version": 1, "config_id": config_id,
                "effort": value, "applied": True,
            })

        def _run_agent_turn(self, *, state, session_id, **kwargs):
            # Native prompt owns is_running before entering this worker. RPC changes reject it.
            explicit = getattr(state, "_hermesian_reasoning", None)
            if explicit is not None:
                state.agent.reasoning_config = dict(explicit)
            token = _turn_reasoning.set(explicit)
            try:
                return super()._run_agent_turn(state=state, session_id=session_id, **kwargs)
            finally:
                _turn_reasoning.reset(token)

    server_mod.HermesACPAgent = HermesianACPAgent
    return _orig_cmd_acp(args)

cli_main.cmd_acp = _hermesian_cmd_acp
if __name__ == "__main__":
    cli_main.main()
`.trim();

export function buildHermesAcpSpawnArgs(
  pythonCommand: PythonCommand,
  cliArgs: string[],
): { command: string; args: string[] } {
  return {
    command: pythonCommand.executable,
    args: [...pythonCommand.argsPrefix, "-I", "-c", HERMES_ACP_ADAPTER_PYTHON_SCRIPT, ...cliArgs],
  };
}

export function isReasoningEffortAck(response: unknown, expectedEffort: string): boolean {
  if (!response || typeof response !== "object") return false;
  const meta = (response as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return false;
  const record = meta as Record<string, unknown>;
  return record.hermesian_version === HERMESIAN_REASONING_EFFORT_VERSION &&
    record.config_id === HERMESIAN_REASONING_EFFORT_CONFIG_ID &&
    record.applied === true && record.effort === expectedEffort;
}
