import type { NamedError } from "@bountyreaper-io/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_ATTEMPTS = 10
  export const RETRY_MAX_TOTAL_MS = 10 * 60 * 1000 // 10 minutes of retries, then fail fast
  export const RETRY_MAX_DELAY_WITH_HEADERS = 120_000 // clamp provider retry-after to 2 minutes
  export const RETRY_FAIL_FAST_AFTER_MS = 10 * 60 * 1000 // retry-after beyond this fails fast
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  const RETRYABLE_MESSAGE_PATTERNS = [
    /429|500|502|503|504|524/i,
    /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
    /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
    /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
    /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
    /try your request again|retry your request|resource exhausted|resource_exhausted/i,
    /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
  ]

  function matchesRetryableMessage(value: unknown) {
    if (typeof value !== "string") return false
    return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
  }

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  function headerDelayMs(headers: Record<string, string>): number | undefined {
    const ms = headers["retry-after-ms"]
    if (ms) {
      const parsed = Number.parseFloat(ms)
      if (!Number.isNaN(parsed)) return Math.max(0, parsed)
    }
    const after = headers["retry-after"]
    if (after) {
      const secs = Number.parseFloat(after)
      if (!Number.isNaN(secs)) return Math.max(0, Math.ceil(secs * 1000))
      const date = Date.parse(after) - Date.now()
      if (!Number.isNaN(date) && date > 0) return Math.ceil(date)
    }
    return undefined
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        // Clamp provider-driven delays: a hours-long retry-after would park
        // the turn indefinitely ("running, 0 tool calls").
        const headerMs = headerDelayMs(headers)
        if (headerMs !== undefined) return Math.min(headerMs, RETRY_MAX_DELAY_WITH_HEADERS)
        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  // Free-tier entitlement failures (403) will NEVER succeed on retry —
  // the model/pool is gated, not throttled. Distinct from quota
  // FreeUsageLimitError (429, retryable). Callers should fail OVER to an
  // entitled twin (e.g. the opencode-go same-name model), not retry.
  const FREETIER_BLOCKED_PATTERNS = [/FreeTierError/i, /free tier can only be used from within OpenCode/i]

  export function freeTierBlocked(error: ReturnType<NamedError["toObject"]>) {
    const texts = [error.data?.message, error.data?.responseBody].filter(
      (v): v is string => typeof v === "string",
    )
    return texts.some((t) => FREETIER_BLOCKED_PATTERNS.some((p) => p.test(t)))
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      const status = error.data.statusCode
      // 5xx errors are transient server failures and should always be retried,
      // even when the provider SDK doesn't explicitly mark them as retryable.
      if (
        !error.data.isRetryable &&
        !(status !== undefined && status >= 500) &&
        !matchesRetryableMessage(error.data.message) &&
        !matchesRetryableMessage(error.data.responseBody)
      )
        return undefined
      // Free-usage quota walls carry retry-after of hours — a session retry
      // would park the turn essentially forever ("running, 0 tool calls").
      // Fail fast so the caller surfaces the quota error immediately.
      if (error.data.responseBody?.includes("FreeUsageLimitError")) return undefined
      // Same for any absurd retry-after: treat as fail-fast, not a parking spot.
      const headers = error.data.responseHeaders
      if (headers) {
        const wait = headerDelayMs(headers)
        if (wait !== undefined && wait > RETRY_FAIL_FAST_AFTER_MS) return undefined
      }
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    try {
      if (!json || typeof json !== "object") return undefined
      const code = typeof json.code === "string" ? json.code : ""

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      return JSON.stringify(json)
    } catch {
      return undefined
    }
  }
}
