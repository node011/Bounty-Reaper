/**
 * Shared limits and defaults.
 *
 * Every list here is bounded. A DevTools panel that grows without limit will
 * eventually take the inspected tab down with it, and losing the browser
 * mid-engagement costs more than losing the oldest capture.
 */
const BR_LIMITS = {
  /** Captured requests kept per tab. Oldest are dropped first. */
  MAX_CAPTURED: 200,
  /** Tabs tracked at once. */
  MAX_TABS: 20,
  /** Completed test runs kept in the panel. */
  MAX_RUNS: 50,
  /** Request body bytes forwarded. Larger bodies are truncated with a marker. */
  MAX_REQUEST_BODY: 65536,
  /** Response body bytes forwarded — the agent needs a sample, not the asset. */
  MAX_RESPONSE_BODY: 8192,
  /** Progress log cap. The final answer is never truncated. */
  MAX_PROGRESS_CHARS: 524288,
}

const BR_DEFAULTS = {
  serverUrl: "http://127.0.0.1:4096",
  filterApiOnly: true,
  captureEnabled: true,
}

/**
 * The instruction sent with a captured request.
 *
 * Deliberately narrow: the operator picked one endpoint, so the agent tests that
 * endpoint. An agent that wanders from a single captured request into the rest
 * of the site is testing things the operator did not look at and may not have
 * authorisation for.
 */
const BR_DEFAULT_INSTRUCTION =
  "Perform web penetration testing on this captured request and report what you find. " +
  "Test only this endpoint — do not expand to other hosts or unrelated APIs."

/** Resource types worth testing. Everything else is page furniture. */
const BR_API_TYPES = new Set(["xhr", "fetch", "websocket", "document", "other"])

/** Extensions that are static assets regardless of the reported resource type. */
const BR_ASSET_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|map)(\?|$)/i

if (typeof globalThis !== "undefined") {
  globalThis.BR_LIMITS = BR_LIMITS
  globalThis.BR_DEFAULTS = BR_DEFAULTS
  globalThis.BR_DEFAULT_INSTRUCTION = BR_DEFAULT_INSTRUCTION
  globalThis.BR_API_TYPES = BR_API_TYPES
  globalThis.BR_ASSET_RE = BR_ASSET_RE
}
