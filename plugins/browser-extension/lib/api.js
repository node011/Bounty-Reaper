/**
 * BountyReper server client.
 *
 * Two calls carry the whole integration:
 *   POST /session/ingest  — hand over a captured request, get a sessionID back
 *   GET  /event   (SSE)   — watch that session's messages stream in
 *
 * The ingest route parses `text` as a raw HTTP request and falls back to
 * treating it as chat text when it cannot. That fallback is silent, which is why
 * lib/http-normalize.js is careful to emit parseable HTTP/1.1.
 */

function brJoin(base, path) {
  return String(base || "").replace(/\/+$/, "") + path
}

/**
 * Auth headers.
 *
 * The server trusts loopback and only demands Basic auth for requests that
 * arrive proxied — a Cloudflare tunnel, say. So a local server needs nothing,
 * and the password field only matters when pointing at a remote one. Sending it
 * unconditionally is harmless and saves the operator a second toggle.
 */
function brAuth(password, username) {
  if (!password) return {}
  const user = username || "bountyreper"
  return { Authorization: "Basic " + btoa(`${user}:${password}`) }
}

/** Is a BountyReper server listening, and which version? */
async function brProbe(serverUrl, { password, username, timeoutMs = 5000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(brJoin(serverUrl, "/global/health"), {
      signal: ctl.signal,
      headers: brAuth(password, username),
    })
    if (res.status === 401) return { ok: false, error: "unauthorized — set the server password" }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const info = await res.json().catch(() => ({}))
    if (!info.healthy) return { ok: false, error: "server reported unhealthy" }
    return { ok: true, version: info.version || "unknown" }
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "timed out" : String(e && e.message ? e.message : e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send one captured request for testing.
 * @returns {Promise<{ok: boolean, sessionID?: string, error?: string}>}
 */
async function brSendCapture(serverUrl, capture, { instruction, sessionID, agent, password, username } = {}) {
  const payload = {
    // The raw request, prefixed with the operator's instruction. The ingest
    // route normalizes the HTTP portion and keeps the prose as context.
    text: `${instruction || BR_DEFAULT_INSTRUCTION}\n\n${capture.raw}`,
    scheme: capture.scheme,
    page_url: capture.url,
    response: capture.response,
  }
  if (sessionID) payload.sessionID = sessionID
  if (agent) payload.agent = agent

  try {
    const res = await fetch(brJoin(serverUrl, "/session/ingest"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...brAuth(password, username) },
      body: JSON.stringify(payload),
    })
    if (res.status === 401) return { ok: false, error: "unauthorized — set the server password" }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` }
    }
    const json = await res.json().catch(() => ({}))
    return { ok: true, sessionID: json.sessionID }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/**
 * Stream a session's output.
 *
 * Returns an abort function. The caller owns cancellation — the panel aborts on
 * Stop, on tab change, and on unload, so a closed panel never leaves the socket
 * open against the operator's server.
 */
function brStreamSession(serverUrl, sessionID, { onText, onDone, onError, password, username }) {
  const ctl = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(brJoin(serverUrl, "/event"), { signal: ctl.signal, headers: brAuth(password, username) })
      if (!res.ok || !res.body) {
        onError && onError(`event stream unavailable (HTTP ${res.status})`)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        let sep
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"))
          if (!dataLine) continue
          let evt
          try {
            evt = JSON.parse(dataLine.slice(5).trim())
          } catch {
            continue
          }
          const props = evt.properties || {}
          const part = props.part || {}
          // Only this session's assistant text.
          if (props.sessionID && props.sessionID !== sessionID) continue
          if (part.sessionID && part.sessionID !== sessionID) continue
          if (evt.type === "message.part.updated" && part.type === "text" && part.text) {
            onText && onText(part.text)
          }
          if (evt.type === "session.idle" && props.sessionID === sessionID) {
            onDone && onDone()
            ctl.abort()
            return
          }
        }
      }
      onDone && onDone()
    } catch (e) {
      if (!ctl.signal.aborted) onError && onError(String(e && e.message ? e.message : e))
    }
  })()

  return () => ctl.abort()
}

if (typeof globalThis !== "undefined") {
  globalThis.brAuth = brAuth
  globalThis.brProbe = brProbe
  globalThis.brSendCapture = brSendCapture
  globalThis.brStreamSession = brStreamSession
}
