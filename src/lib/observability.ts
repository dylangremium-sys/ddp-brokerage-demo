// ─── Observability primitives (P0-B) ────────────────────────────────────────
//
// The server had exactly one function (api/compliance/ai-summary.ts) and its
// catch block swallowed every exception with no log at all: a production failure
// left zero trace anywhere, so an outage was diagnosable only if a user reported
// it. This module is the smallest thing that fixes that WITHOUT a third-party
// monitoring dependency — Vercel already captures stdout/stderr into runtime logs,
// so one structured console.error is enough.
//
// The privacy constraint is the hard part. An exception thrown near an AI call can
// carry the prompt, the source legal text, the provider's response, the caller's
// bearer token or their email. NONE of that may be logged. The defence here is
// structural rather than a best-effort scrub: the log functions accept ONLY a
// closed set of named, non-sensitive fields, and they build the emitted object
// field by field. A raw Error is not accepted by the type system and cannot be
// passed through — there is no code path that puts one into a log line.

/** The only fields ever emitted. Every one is safe by construction:
 *  no message, no stack, no header, no body, no prompt, no vendor text. */
export interface SafeLogEvent {
  /** What happened, as a fixed identifier — never free text. */
  event: string
  /** Correlation ID, echoed to the client so a user report maps to a log line. */
  requestId: string
  /** A machine-readable error code (e.g. 'internal_error'), never a message. */
  category: string
  /** HTTP status for server events; omitted for client events. */
  status?: number
  /** HTTP method for server events; omitted for client events. */
  method?: string
  /** Route or component name — a code location, not user data. */
  route: string
}

/** Machine codes are `[a-z0-9_]`. Anything else — a message, a prompt, a token,
 *  an email, a stack — is replaced wholesale. This is the last line of defence:
 *  even if a future caller wrongly passes an exception message as the category,
 *  it cannot reach the log. */
const MACHINE_CODE = /^[a-z0-9_]{1,40}$/

function safeCode(value: string): string {
  return MACHINE_CODE.test(value) ? value : 'unknown_error'
}

/**
 * A random correlation ID.
 *
 * Deliberately derived from a CSPRNG only — never from the request body, a token,
 * an IP, an email, the prompt, or a timestamp, all of which would make the ID
 * itself a carrier of the data it is supposed to help us avoid logging.
 *
 * The final fallback is Math.random: weaker, but this is a correlation handle and
 * never a secret or a security control, so unpredictability is not required.
 */
export function newRequestId(): string {
  const c: Crypto | undefined = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  let out = ''
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

/** Builds the emitted record field by field. Nothing the caller did not name
 *  explicitly can ride along — spreading the input is deliberately avoided. */
function record(e: SafeLogEvent): Record<string, string | number> {
  const out: Record<string, string | number> = {
    event: safeCode(e.event),
    requestId: e.requestId,
    category: safeCode(e.category),
    route: e.route,
    at: new Date().toISOString(),
  }
  if (typeof e.status === 'number') out.status = e.status
  if (typeof e.method === 'string') out.method = safeCode(e.method.toLowerCase())
  return out
}

/**
 * One structured line to stderr. Vercel captures this into the function's runtime
 * logs, where the requestId returned to the caller can be searched for.
 */
export function logServerError(e: SafeLogEvent): void {
  console.error(JSON.stringify(record(e)))
}

/**
 * The browser-side equivalent, emitted by the top-level error boundary. It carries
 * no error message, no component stack and no stored value — only that a crash
 * happened, and the reference code shown to the user.
 */
export function logClientError(e: SafeLogEvent): void {
  console.error(JSON.stringify(record(e)))
}
