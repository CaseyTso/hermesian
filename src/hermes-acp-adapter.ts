import { buildHermesPythonArgs, type PythonCommand } from "./hermes-model-catalog";

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
import json

_orig_resolve_reasoning = hermes_constants.resolve_reasoning_config
_turn_reasoning = contextvars.ContextVar("hermesian_turn_reasoning", default=None)

def _resolve_reasoning(cfg=None, model=""):
    explicit = _turn_reasoning.get()
    return dict(explicit) if explicit is not None else _orig_resolve_reasoning(cfg, model)

hermes_constants.resolve_reasoning_config = _resolve_reasoning
_orig_cmd_acp = cli_main.cmd_acp

def _install_restore_provider_heal(server_mod):
    """Heal a bare "custom" provider when an ACP session is restored.

    SessionManager._persist records the agent's *billing class* (custom), so every
    named endpoint — CLIProxy Antigravity and friends — loses its durable identity in
    state.db. _restore used to hand that bare value straight to _make_agent,
    where resolve_runtime_provider falls through to the OpenRouter fallback key and
    the session 401s on the very next turn. Hermes ships the intended lookup,
    canonical_custom_identity ("every session persistence/restore path shares this
    lookup"); the ACP restore path simply never called it. Patch it here instead of
    touching the installed source, and fail open to the native path whenever the
    endpoint cannot be identified with certainty.
    """
    from acp_adapter.session import SessionManager
    original_restore = SessionManager._restore
    if getattr(original_restore, "_hermesian_heal", False):
        return

    def _restore(self, session_id):
        provider_override = _healed_restore_provider(self, session_id)
        if provider_override is None:
            return original_restore(self, session_id)
        return _restore_with_provider(original_restore, self, session_id, provider_override)

    _restore._hermesian_heal = True
    SessionManager._restore = _restore


def _restore_with_provider(original_restore, manager, session_id, provider):
    """Run the native restore with one healed keyword argument.

    The manager's _make_agent is re-bound for the duration of this single restore, injecting
    requested_provider only for the agent build it performs; DB reads, history, locking,
    error handling and the returned state stay exactly native. A build failure still
    propagates to the native except clause and yields the same None.
    """
    native_make_agent = manager._make_agent

    def _patched_make_agent(**kwargs):
        kwargs["requested_provider"] = provider
        return native_make_agent(**kwargs)

    manager._make_agent = _patched_make_agent
    try:
        return original_restore(manager, session_id)
    finally:
        if manager._make_agent is _patched_make_agent:
            manager._make_agent = native_make_agent


def _healed_restore_provider(manager, session_id):
    """Return the named provider identity for a bare-"custom" session, else None.

    None means "leave the native restore alone": a non-custom provider, an already
    routable identity, a row with no endpoint to identify it by, or an identity that
    does not resolve back to a real route. The session's own base_url is the only
    trusted anchor — canonical_custom_identity also accepts a bare model name, which
    would let a multi-endpoint setup guess the wrong provider, so that path is refused
    unless it lands on the same endpoint.
    """
    try:
        from hermes_cli.runtime_provider_custom import canonical_custom_identity, is_routable_provider
        from hermes_cli.runtime_provider import resolve_runtime_provider

        row = manager._get_db().get_session(session_id)
        if not isinstance(row, dict) or row.get("source") != "acp":
            return None
        meta = row.get("model_config")
        meta = json.loads(meta) if isinstance(meta, str) else {}
        if not isinstance(meta, dict):
            meta = {}
        requested = str(meta.get("provider") or row.get("billing_provider") or "").strip()
        if requested.lower() != "custom":
            return None
        base_url = str(meta.get("base_url") or row.get("billing_base_url") or "").strip()
        if not base_url:
            # No endpoint anchor: identifying the entry from a model name alone could pick
            # the wrong provider in a multi-endpoint setup, so keep the native path.
            return None
        model = row.get("model")
        identity = canonical_custom_identity(
            base_url=base_url or None, config_provider=requested, model=str(model or "") or None)
        if not identity or not is_routable_provider(identity):
            return None
        # Anchor on the recorded endpoint: a healed identity must route back to it.
        runtime = resolve_runtime_provider(requested=identity, target_model=str(model or "") or None)
        if _normalized_url(runtime.get("base_url")) != _normalized_url(base_url):
            return None
        return identity
    except Exception:
        # Missing helper, unreadable row, unexpected shape: keep native behavior.
        return None


def _normalized_url(value):
    """Compare endpoints without trailing-slash or case noise."""
    text = str(value or "").strip().rstrip("/")
    return text.lower() if text else ""


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
    _install_restore_provider_heal(server_mod)
    return _orig_cmd_acp(args)

cli_main.cmd_acp = _hermesian_cmd_acp

# Installed at import time rather than inside the ACP entry: the heal wrapper must be active
# for every SessionManager the server builds, including ones created before cmd_acp runs.
try:
    import acp_adapter.server as _hermesian_server_module
    _install_restore_provider_heal(_hermesian_server_module)
except Exception:
    # Older layout without acp_adapter.server, or an unexpected shape: fail open to native.
    pass

if __name__ == "__main__":
    cli_main.main()
`.trim();

export function buildHermesAcpSpawnArgs(
  pythonCommand: PythonCommand,
  cliArgs: string[],
): { command: string; args: string[] } {
  return {
    command: pythonCommand.executable,
    args: buildHermesPythonArgs(pythonCommand, HERMES_ACP_ADAPTER_PYTHON_SCRIPT, cliArgs),
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
