/**
 * HAR entry -> raw HTTP/1.1 request text.
 *
 * BountyReper's /session/ingest parses `text` as a raw HTTP request, so the
 * capture has to come back out as bytes on the wire, not as a JSON object.
 *
 * Chrome reports HTTP/2 and HTTP/3 traffic with pseudo-headers (`:method`,
 * `:authority`, `:path`, `:scheme`). Those are framing metadata, not headers —
 * emitting them produces a request no HTTP/1.1 parser accepts, and the ingest
 * route would silently fall through to its plain-text branch and treat the whole
 * capture as a chat message. So they are dropped and `:authority` is folded into
 * `Host`, which is the HTTP/1.1 equivalent.
 */

/** Pseudo-headers and hop-by-hop headers that must not survive normalization. */
const BR_DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  // Content-Length is recomputed from the body we actually forward, which may
  // have been truncated — carrying the original over would describe bytes that
  // are not there.
  "content-length",
])

function brHeaderList(headers) {
  return (headers || []).filter((h) => h && typeof h.name === "string")
}

/** Build `Host` from the HTTP/2 :authority pseudo-header or the URL. */
function brResolveHost(headers, url) {
  const authority = brHeaderList(headers).find((h) => h.name.toLowerCase() === ":authority")
  if (authority && authority.value) return authority.value
  const host = brHeaderList(headers).find((h) => h.name.toLowerCase() === "host")
  if (host && host.value) return host.value
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

/** Path + query, from the URL. Absolute-URI request lines confuse some parsers. */
function brResolvePath(url) {
  try {
    const u = new URL(url)
    return (u.pathname || "/") + (u.search || "")
  } catch {
    return url || "/"
  }
}

function brScheme(url) {
  try {
    return new URL(url).protocol === "http:" ? "http" : "https"
  } catch {
    return "https"
  }
}

/**
 * Serialize a HAR request into raw HTTP/1.1.
 *
 * @param {object} req  HAR `request` object
 * @param {string} body request body text (already truncated by the caller)
 * @returns {string}
 */
function brToRawHttp(req, body) {
  const method = (req.method || "GET").toUpperCase()
  const path = brResolvePath(req.url)
  const host = brResolveHost(req.headers, req.url)

  const lines = [`${method} ${path} HTTP/1.1`]
  if (host) lines.push(`Host: ${host}`)

  const seen = new Set(["host"])
  for (const h of brHeaderList(req.headers)) {
    const name = h.name.toLowerCase()
    // Pseudo-headers start with ":" — framing, not headers.
    if (name.startsWith(":")) continue
    if (BR_DROP_HEADERS.has(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    lines.push(`${h.name}: ${h.value ?? ""}`)
  }

  if (body) lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`)

  lines.push("")
  lines.push(body || "")
  return lines.join("\r\n")
}

/** Response headers as a plain object, for the ingest `response` field. */
function brResponseHeaders(res) {
  const out = {}
  for (const h of brHeaderList(res && res.headers)) {
    const name = h.name.toLowerCase()
    if (name.startsWith(":")) continue
    out[h.name] = h.value ?? ""
  }
  return out
}

if (typeof globalThis !== "undefined") {
  globalThis.brToRawHttp = brToRawHttp
  globalThis.brResponseHeaders = brResponseHeaders
  globalThis.brScheme = brScheme
  globalThis.brResolveHost = brResolveHost
}
