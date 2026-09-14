# BountyReaper Browser Extension

Chromium DevTools extension: capture the traffic **you** generate while browsing,
pick a request, and hand it to BountyReaper for AI-assisted testing.

This is the human-driven capture path. It complements
[`hackbrowser`](../../packages/hackbrowser), which crawls autonomously:

|            | This extension                                               | hackbrowser                         |
| ---------- | ------------------------------------------------------------ | ----------------------------------- |
| Who drives | you                                                          | the agent                           |
| Reaches    | anything you can reach — logged in, past MFA, deep SPA state | whatever it can navigate to unaided |
| Scope      | the one request you select                                   | up to 200 pages                     |
| Use it for | authenticated surface, flows a crawler can't reproduce       | unauthenticated discovery, breadth  |

hackbrowser already needs a human present for authenticated crawls — it opens a
visible browser and waits for you to log in. This extension is the better tool
for that case: you were going to drive the browser anyway.

## Install

1. `chrome://extensions/` → enable **Developer mode** → **Load unpacked**
2. Select this directory (`plugins/browser-extension/`)
3. Start a server: `bountyreaper serve` (defaults to `http://127.0.0.1:4096`)
4. Open the target → **F12** → **BountyReaper** tab → **Validate**

## Use

1. **Browse.** Requests accumulate in the left list while ● Capturing is on.
2. **Select** one. The raw HTTP/1.1 it will send appears on the right.
3. **Send.** Output streams back into the panel.
4. **Stop** aborts the stream.

Sends reuse one session, so the agent keeps context as you work through several
endpoints on the same target.

## Server connection

Local servers need no credentials — BountyReaper trusts loopback and only demands
Basic auth for requests arriving proxied (through a Cloudflare tunnel, say). Fill
the password field only when pointing at a remote server; it's the value of
`BOUNTYREAPER_SERVER_PASSWORD`.

## What gets sent

`POST /session/ingest` with:

| Field      | Contents                                           |
| ---------- | -------------------------------------------------- |
| `text`     | your instruction, then the request as raw HTTP/1.1 |
| `scheme`   | `http` / `https`                                   |
| `page_url` | the full captured URL                              |
| `response` | status, headers, and a body sample                 |

Results stream from `GET /event` (SSE), filtered to your session.

### Why raw HTTP/1.1 matters

`/session/ingest` parses `text` as an HTTP request and, when it can't, **silently
falls back** to treating the payload as a chat message — no error, just an agent
musing about a blob of text instead of testing an endpoint.

Chrome reports HTTP/2 and HTTP/3 traffic with pseudo-headers (`:method`,
`:authority`, `:path`, `:scheme`). Those are framing metadata; emitting them
produces something no HTTP/1.1 parser accepts. So
[`lib/http-normalize.js`](lib/http-normalize.js) drops them, folds `:authority`
into `Host`, strips hop-by-hop headers, and recomputes `Content-Length` from the
body actually forwarded (bodies get truncated, and the captured length would
describe bytes that aren't there).

[`test/normalize.test.js`](test/normalize.test.js) covers this:

```bash
cd plugins/browser-extension && bun test
```

## Limits

Everything is bounded — a DevTools panel that grows without limit eventually
takes the inspected tab down with it.

| Data             | Limit                     |
| ---------------- | ------------------------- |
| Captures per tab | 200 (oldest dropped)      |
| Tabs tracked     | 20 (least recent evicted) |
| Request body     | 64 KB                     |
| Response body    | 8 KB                      |
| Progress log     | 512 KB                    |

Static assets (js/css/images/fonts/media) are never captured. **XHR/Fetch only**
narrows further to API traffic; turn it off to include documents.

## Notes

- Captured traffic lives in memory only. Bodies routinely contain session
  cookies, so nothing is written to `chrome.storage` — only your server URL,
  password and preferences are.
- The default instruction says _"Test only this endpoint — do not expand to other
  hosts or unrelated APIs."_ You picked one request; testing things you didn't
  look at may exceed what you're authorised for.
- Host permissions are **optional** and requested per-target, not granted up
  front for `<all_urls>`.
