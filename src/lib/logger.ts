/**
 * Structured logging. Vercel captures stdout as JSON, so emitting objects keeps
 * pipeline runs greppable by documentId/stage when something fails at 3am.
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function emit(level: Level, message: string, fields?: Fields) {
  const payload = { level, message, ts: new Date().toISOString(), ...fields };
  const line = JSON.stringify(payload, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, f?: Fields) => emit("debug", m, f),
  info: (m: string, f?: Fields) => emit("info", m, f),
  warn: (m: string, f?: Fields) => emit("warn", m, f),
  error: (m: string, f?: Fields) => emit("error", m, f),
  /** Scoped child logger so every line in a stage carries its context. */
  child(base: Fields) {
    return {
      debug: (m: string, f?: Fields) => emit("debug", m, { ...base, ...f }),
      info: (m: string, f?: Fields) => emit("info", m, { ...base, ...f }),
      warn: (m: string, f?: Fields) => emit("warn", m, { ...base, ...f }),
      error: (m: string, f?: Fields) => emit("error", m, { ...base, ...f }),
    };
  },
};
