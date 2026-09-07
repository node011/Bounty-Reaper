/**
 * The normalizer is the load-bearing piece of this extension.
 *
 * /session/ingest parses `text` as a raw HTTP request and, when it cannot,
 * silently falls back to treating the whole payload as a chat message. That
 * failure is invisible — no error, just an agent musing about a blob of text
 * instead of testing an endpoint. So the output has to be valid HTTP/1.1 for
 * every shape Chrome hands us, including HTTP/2 and HTTP/3 captures.
 *
 * Run: bun test plugins/browser-extension/test/normalize.test.js
 */

import { describe, expect, test } from "bun:test"
import path from "path"

// The extension ships as plain scripts that assign to globalThis, so load them
// the same way the browser does rather than restructuring for the test.
const dir = path.join(import.meta.dir, "..")
for (const f of ["lib/constants.js", "lib/http-normalize.js", "lib/capture.js"]) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(await Bun.file(path.join(dir, f)).text())
}

const h = (o) => Object.entries(o).map(([name, value]) => ({ name, value }))

describe("brToRawHttp", () => {
  test("emits a valid HTTP/1.1 request line and Host", () => {
    const raw = brToRawHttp({ method: "get", url: "https://api.example.com/v1/users?id=3", headers: [] }, "")
    const lines = raw.split("\r\n")
    expect(lines[0]).toBe("GET /v1/users?id=3 HTTP/1.1")
    expect(lines[1]).toBe("Host: api.example.com")
  })

  test("drops HTTP/2 pseudo-headers and folds :authority into Host", () => {
    const raw = brToRawHttp(
      {
        method: "POST",
        url: "https://api.example.com/login",
        headers: h({
          ":method": "POST",
          ":authority": "api.example.com",
          ":path": "/login",
          ":scheme": "https",
          "content-type": "application/json",
        }),
      },
      '{"u":"a"}',
    )
    expect(raw).not.toContain(":method")
    expect(raw).not.toContain(":authority")
    expect(raw).not.toContain(":path")
    expect(raw).not.toContain(":scheme")
    expect(raw).toContain("Host: api.example.com")
    expect(raw).toContain("content-type: application/json")
  })

  test("drops hop-by-hop headers", () => {
    const raw = brToRawHttp(
      {
        method: "GET",
        url: "https://a.com/x",
        headers: h({ connection: "keep-alive", te: "trailers", accept: "*/*" }),
      },
      "",
    )
    expect(raw.toLowerCase()).not.toContain("connection:")
    expect(raw.toLowerCase()).not.toContain("te: trailers")
    expect(raw).toContain("accept: */*")
  })

  test("recomputes Content-Length from the body actually sent", () => {
    // The captured header claims 9999; the body we forward is 5 bytes. Carrying
    // the original over would describe bytes that are not in the request.
    const raw = brToRawHttp(
      { method: "POST", url: "https://a.com/x", headers: h({ "content-length": "9999" }) },
      "hello",
    )
    expect(raw).toContain("Content-Length: 5")
    expect(raw).not.toContain("9999")
  })

  test("Content-Length counts bytes, not characters", () => {
    const body = "café→"
    const raw = brToRawHttp({ method: "POST", url: "https://a.com/x", headers: [] }, body)
    expect(raw).toContain(`Content-Length: ${new TextEncoder().encode(body).length}`)
    expect(raw).not.toContain(`Content-Length: ${body.length}`)
  })

  test("headers and body are separated by a blank line", () => {
    const raw = brToRawHttp({ method: "POST", url: "https://a.com/x", headers: h({ accept: "*/*" }) }, "BODY")
    expect(raw).toContain("\r\n\r\nBODY")
  })

  test("no duplicate Host when the capture already has one", () => {
    const raw = brToRawHttp(
      { method: "GET", url: "https://a.com/x", headers: h({ Host: "a.com", ":authority": "a.com" }) },
      "",
    )
    expect(raw.match(/^Host:/gim).length).toBe(1)
  })

  test("root path when the URL has none", () => {
    expect(brToRawHttp({ method: "GET", url: "https://a.com", headers: [] }, "")).toContain("GET / HTTP/1.1")
  })

  test("survives a malformed URL without throwing", () => {
    expect(() => brToRawHttp({ method: "GET", url: "not a url", headers: [] }, "")).not.toThrow()
  })
})

describe("brScheme", () => {
  test("reads the scheme off the URL", () => {
    expect(brScheme("http://a.com/x")).toBe("http")
    expect(brScheme("https://a.com/x")).toBe("https")
  })
  test("defaults to https when unparseable", () => {
    // Matches the server's own inferScheme default: treating http as https only
    // inflates dedup space, never loses data.
    expect(brScheme("garbage")).toBe("https")
  })
})

describe("brShouldCapture", () => {
  test("keeps API traffic", () => {
    expect(brShouldCapture("https://a.com/api/u", "xhr", true)).toBe(true)
    expect(brShouldCapture("https://a.com/api/u", "fetch", true)).toBe(true)
  })

  test("drops static assets even when the type says otherwise", () => {
    for (const u of [
      "https://a.com/app.js",
      "https://a.com/x.css",
      "https://a.com/logo.png",
      "https://a.com/f.woff2",
    ]) {
      expect(brShouldCapture(u, "xhr", true)).toBe(false)
    }
  })

  test("drops non-http schemes", () => {
    expect(brShouldCapture("chrome-extension://abc/x", "xhr", true)).toBe(false)
    expect(brShouldCapture("data:text/html,hi", "document", false)).toBe(false)
    expect(brShouldCapture("blob:https://a.com/uuid", "xhr", false)).toBe(false)
  })

  test("filter off still excludes assets", () => {
    expect(brShouldCapture("https://a.com/app.js", "script", false)).toBe(false)
    expect(brShouldCapture("https://a.com/page", "document", false)).toBe(true)
  })
})

describe("brSummarize", () => {
  const entry = (over = {}) => ({
    request: {
      method: "POST",
      url: "https://api.example.com/v1/login?next=/home",
      headers: h({ ":authority": "api.example.com", "content-type": "application/json" }),
      postData: { text: '{"u":"admin"}' },
    },
    response: {
      status: 200,
      headers: h({ "content-type": "application/json" }),
      content: { mimeType: "application/json" },
    },
    ...over,
  })

  test("extracts the fields the panel and ingest need", () => {
    const c = brSummarize(entry(), '{"ok":true}', "xhr")
    expect(c.method).toBe("POST")
    expect(c.host).toBe("api.example.com")
    expect(c.path).toBe("/v1/login?next=/home")
    expect(c.scheme).toBe("https")
    expect(c.status).toBe(200)
    expect(c.raw).toContain("POST /v1/login?next=/home HTTP/1.1")
    expect(c.response.body).toBe('{"ok":true}')
  })

  test("truncates oversized bodies and flags it", () => {
    const big = "x".repeat(BR_LIMITS.MAX_RESPONSE_BODY + 500)
    const c = brSummarize(entry(), big, "xhr")
    expect(c.responseTruncated).toBe(true)
    expect(c.response.body.length).toBeLessThan(big.length)
    expect(c.response.body).toContain("[truncated")
  })

  test("ids are unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => brSummarize(entry(), "", "xhr").id))
    expect(ids.size).toBe(200)
  })
})
