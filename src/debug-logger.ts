export type DebugEvent =
  | "client.connect.start"
  | "client.connect.ready"
  | "client.process.exit"
  | "controller.background.failure"
  | "session.operation.start"
  | "session.operation.finish"
  | "controller.transition.invalidated"
  | "controller.tab.operation";

export type SafeDebugValue = string | number | boolean | null | undefined;

export interface SafeDebugFields {
  [key: string]: SafeDebugValue;
}

export interface DebugLogger {
  debug(event: DebugEvent, fields?: SafeDebugFields): void;
  warn(event: DebugEvent, fields?: SafeDebugFields): void;
  error(event: DebugEvent, fields?: SafeDebugFields): void;
}

const ALLOWED_FIELDS = new Set<string>([
  "code",
  "durationMs",
  "errorCode",
  "generation",
  "operation",
  "ordinal",
  "reason",
  "signal",
]);

function sanitize(raw: Record<string, unknown>): SafeDebugFields {
  const safe: SafeDebugFields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function safeErrorFields(error: unknown): SafeDebugFields {
  if (!(error instanceof Error)) {
    return {};
  }
  const fields: SafeDebugFields = {};
  if (error.name) {
    fields.errorCode = error.name;
  }
  // Do NOT include error.message — it may contain paths, session IDs, etc.
  return fields;
}

const NOOP_LOGGER: DebugLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export function createDebugLogger(enabled: boolean): DebugLogger {
  if (!enabled) {
    return NOOP_LOGGER;
  }

  const log =
    (level: "debug" | "warn" | "error") =>
    (event: DebugEvent, fields?: SafeDebugFields): void => {
      const payload: Record<string, unknown> = {
        event,
        ...(fields ? sanitize(fields) : {}),
      };
      if (level === "error") {
        console.error("[hermesian]", payload);
      } else if (level === "warn") {
        console.warn("[hermesian]", payload);
      } else {
        console.debug("[hermesian]", payload);
      }
    };

  return {
    debug: log("debug"),
    warn: log("warn"),
    error: log("error"),
  };
}

export { safeErrorFields };
