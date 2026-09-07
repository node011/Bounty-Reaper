/**
 * Capture filtering and summarisation.
 *
 * Runs on every finished request in the inspected tab, so it stays cheap: the
 * decision to keep a request is made from the URL and resource type before any
 * body is fetched. `getContent()` is the expensive call and only fires for
 * requests that survive the filter.
 */

/** Should this request be captured at all? Called before getContent(). */
function brShouldCapture(url, resourceType, filterApiOnly) {
  if (!url || !/^https?:/i.test(url)) return false
  // Data/blob URLs and extension traffic are not the target's surface.
  if (/^chrome-extension:|^blob:|^data:/i.test(url)) return false
  if (!filterApiOnly) return !BR_ASSET_RE.test(url)
  if (BR_ASSET_RE.test(url)) return false
  return BR_API_TYPES.has(String(resourceType || "other").toLowerCase())
}

/** Chrome does not always set _resourceType; fall back to the content type. */
function brInferResourceType(url, responseHeaders) {
  const ct = (brHeaderList(responseHeaders).find((h) => h.name.toLowerCase() === "content-type") || {}).value || ""
  if (/json|xml|x-www-form-urlencoded/i.test(ct)) return "xhr"
  if (/text\/html/i.test(ct)) return "document"
  if (BR_ASSET_RE.test(url)) return "asset"
  return "other"
}

function brTruncate(text, max) {
  if (typeof text !== "string") return { text: "", truncated: false }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + `\n\n[truncated ${text.length - max} more chars]`, truncated: true }
}

/**
 * Reduce a HAR entry to what the panel lists and what ingest needs.
 * Bodies are truncated here, once, so nothing downstream has to remember to.
 */
function brSummarize(entry, responseBody, resourceType) {
  const req = entry.request || {}
  const res = entry.response || {}

  const postText = (req.postData && req.postData.text) || ""
  const reqBody = brTruncate(postText, BR_LIMITS.MAX_REQUEST_BODY)
  const resBody = brTruncate(responseBody || "", BR_LIMITS.MAX_RESPONSE_BODY)

  let pathLabel = req.url || ""
  try {
    const u = new URL(req.url)
    pathLabel = u.pathname + (u.search || "")
  } catch {}

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method: (req.method || "GET").toUpperCase(),
    url: req.url || "",
    host: brResolveHost(req.headers, req.url),
    path: pathLabel,
    scheme: brScheme(req.url),
    status: res.status || 0,
    mimeType: (res.content && res.content.mimeType) || "",
    resourceType: resourceType || "other",
    time: Date.now(),
    raw: brToRawHttp(req, reqBody.text),
    requestTruncated: reqBody.truncated,
    response: {
      status: res.status || 0,
      headers: brResponseHeaders(res),
      body: resBody.text,
    },
    responseTruncated: resBody.truncated,
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.brShouldCapture = brShouldCapture
  globalThis.brInferResourceType = brInferResourceType
  globalThis.brSummarize = brSummarize
  globalThis.brTruncate = brTruncate
}
