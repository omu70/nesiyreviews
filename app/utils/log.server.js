// =============================================================
// Production logging
// File: /app/utils/log.server.js
//
// Two jobs:
//
//   1. Keep personal data out of the logs. Review bodies, reviewer
//      names, emails, IPs and access tokens must never be written to
//      a log line — they are Level 2 protected customer data, and a
//      log drain is a copy of your database you forgot you made.
//
//   2. Give a Supabase / Shopify error enough shape to debug from
//      without echoing it to the caller. Storefront shoppers and
//      merchants get a sentence; the log gets the detail.
//
// Output is one JSON object per line, which every host's log viewer
// can filter on.
// =============================================================

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = String(process.env.LOG_LEVEL || "").toLowerCase();
const THRESHOLD =
  configured in LEVELS
    ? LEVELS[configured]
    : process.env.NODE_ENV === "production"
      ? LEVELS.info
      : LEVELS.debug;

// Anything whose key looks like one of these is replaced wholesale.
const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|cookie|signature|hmac)/i;
// Anything whose key looks like one of these is reduced to a shape.
const PII_KEY = /(email|author_name|content|reply|ip|address|phone|customer_email)/i;

function redactValue(key, value) {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (PII_KEY.test(key)) {
    if (value == null) return null;
    if (typeof value === "string") return `[${value.length} chars]`;
    return "[redacted]";
  }
  return value;
}

function scrub(input, depth = 0) {
  if (input == null || depth > 4) return input;
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (input instanceof Error) {
    return { name: input.name, message: input.message };
  }
  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const redacted = redactValue(k, v);
      out[k] = redacted === v ? scrub(v, depth + 1) : redacted;
    }
    return out;
  }
  return input;
}

function emit(level, event, fields) {
  if (LEVELS[level] > THRESHOLD) return;
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...scrub(fields || {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  error: (event, fields) => emit("error", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  info: (event, fields) => emit("info", event, fields),
  debug: (event, fields) => emit("debug", event, fields),
};

/**
 * Log a Supabase error and return a generic, caller-safe message.
 * PostgREST errors carry the failing SQL fragment and column names —
 * useful in a log, an information leak in an HTTP response.
 */
export function dbError(event, error, fields = {}) {
  log.error(event, {
    ...fields,
    code: error?.code || null,
    message: error?.message || String(error),
    hint: error?.hint || null,
  });
  return "Something went wrong on our side. Please try again.";
}
