#!/usr/bin/env python3
"""
Burp Suite MCP Client — canonical transport layer
===================================================
ALL HTTP traffic for this workspace goes through Burp Suite.
Never use curl, requests, or urllib.request directly for target requests.

Two transport modes
-------------------
proxy_request(url, method, headers, body)
    Routes through Burp proxy listener at 127.0.0.1:8080 via HTTP CONNECT
    tunnel — identical to a browser with manual proxy set.
    Every call appears in Burp Proxy > HTTP History.
    USE THIS for all active recon and testing — it's the default.

send_http1(hostname, port, https, method, path, headers, body)
send_http2(hostname, port, https, method, path, headers, body)
    Use Burp MCP send_http1_request / send_http2_request (direct internal
    connection — does NOT appear in Proxy History by itself).
    Use only when you also call repeater_tab() for the same request.

Repeater helpers
----------------
repeater_tab(hostname, port, https, method, path, headers, body, tab_name)
    Create HTTP/1.1 Repeater tab.

repeater_tab_http2(hostname, port, https, method, path, headers, body, tab_name)
    Create HTTP/2 Repeater tab.

MCP utilities
-------------
call_tool(tool_name, params)   — raw MCP tool call
list_tools()                   — enumerate available Burp MCP tools
get_proxy_history(count, offset, regex)
    Pull and parse Burp proxy history into list of dicts.
get_scanner_issues(count, offset)
    Pull Burp scanner findings.
generate_collaborator_payload()
    Generate a Burp Collaborator OOB URL.
get_collaborator_interactions()
    Poll for DNS/HTTP/SMTP callbacks — returns ALL interactions for ALL
    payloads generated this Burp session (BApp v1.1.2: no payloadId arg).

CLI
---
python3 burp_mcp_client.py --list-tools
python3 burp_mcp_client.py --proxy-get <url> [json_headers]
python3 burp_mcp_client.py --proxy-history [count] [regex] [--newest]
python3 burp_mcp_client.py <tool_name> [json_params]

Burp MCP BApp v1.1.2 — SSE endpoint: http://127.0.0.1:9876/
Burp Proxy listener:                  http://127.0.0.1:8080
MCP protocol version: 2024-11-05

Tool schema reference (confirmed from tools/list)
--------------------------------------------------
send_http1_request / create_repeater_tab:
    required: content (str), targetHostname, targetPort (int), usesHttps (bool)
    'content' = full raw HTTP/1.1 request string

send_http2_request / create_repeater_tab_http2:
    required: pseudoHeaders (dict), headers (dict), requestBody (str),
              targetHostname, targetPort (int), usesHttps (bool)

get_proxy_http_history / get_scanner_issues:
    required: count (int), offset (int)

get_proxy_http_history_regex:
    required: count (int), offset (int), regex (str)

generate_collaborator_payload:
    optional: customData (str)

get_collaborator_interactions:
    required: payloadId (str)
"""

import urllib.request
import urllib.parse
import urllib.error
import http.client
import ssl
import socket
import json
import sys
import time

# ── Connection config ────────────────────────────────────────────────────────
BURP_SSE_URL   = "http://127.0.0.1:9876"
BURP_PROXY_HOST = "127.0.0.1"
BURP_PROXY_PORT = 8080


# ═══════════════════════════════════════════════════════════════════════════════
# Low-level MCP SSE transport
# ═══════════════════════════════════════════════════════════════════════════════

def open_session():
    """
    Open SSE connection to Burp MCP server.
    Returns (sse_stream, session_post_url).
    The SSE stream must stay open while you call _post() and _read_response().
    """
    req = urllib.request.Request(
        BURP_SSE_URL + "/",
        headers={"Accept": "text/event-stream"}
    )
    sse = urllib.request.urlopen(req, timeout=10)
    # The server sends:
    #   event: endpoint
    #   data: ?sessionId=<uuid>
    # Read lines until we get the session path
    for line in sse:
        line = line.decode("utf-8", errors="replace").strip()
        if line.startswith("data:"):
            session_path = line.replace("data:", "").strip()
            # session_path looks like: ?sessionId=<uuid>
            # POST endpoint is BURP_SSE_URL + session_path  (i.e. root '/' + qs)
            return sse, BURP_SSE_URL + "/" + session_path
    raise RuntimeError("Burp MCP: no session endpoint received — is BApp loaded?")


def _post(session_url, payload):
    """POST a JSON-RPC 2.0 message to the active session endpoint."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        session_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as e:
        if e.code not in (200, 202):
            raise


def _read_response(sse, req_id, timeout=30):
    """
    Read the SSE stream until a JSON-RPC response with matching id arrives.
    The response comes back on the SSE channel, not in the POST HTTP response body.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            line = sse.readline().decode("utf-8", errors="replace").strip()
        except Exception:
            break
        if line.startswith("data:"):
            try:
                msg = json.loads(line[5:].strip())
                if msg.get("id") == req_id:
                    return msg
            except json.JSONDecodeError:
                pass
    raise TimeoutError(
        f"Burp MCP: no response for id={req_id} within {timeout}s — "
        "check Burp is running with MCP BApp enabled"
    )


def _init_session(sse, session_url):
    """Perform MCP handshake: initialize → initialized notification."""
    _post(session_url, {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "bob-security-operator", "version": "2.0"},
        },
    })
    _read_response(sse, 1)
    _post(session_url, {
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {},
    })


# ═══════════════════════════════════════════════════════════════════════════════
# Proxy-routed transport  ← USE THIS — shows in Burp Proxy > HTTP History
# ═══════════════════════════════════════════════════════════════════════════════

def proxy_request(url, method="GET", headers=None, body=None, timeout=30):
    """
    Route a request through Burp's proxy listener (127.0.0.1:8080).
    Uses HTTP CONNECT tunnel for HTTPS — identical to a browser with
    manual proxy configured.  Every call appears in Proxy > HTTP History.

    Returns (status_code: int, response_headers: dict, body: str).

    Example
    -------
    status, resp_hdrs, body = proxy_request(
        "https://api.target.com/v1/users",
        headers={"Authorization": "Bearer eyJ..."},
    )
    """
    if headers is None:
        headers = {}

    parsed   = urllib.parse.urlparse(url)
    scheme   = parsed.scheme.lower()
    hostname = parsed.hostname
    port     = parsed.port or (443 if scheme == "https" else 80)
    path     = (parsed.path or "/") + (("?" + parsed.query) if parsed.query else "")

    if scheme == "https":
        proxy_sock = socket.create_connection(
            (BURP_PROXY_HOST, BURP_PROXY_PORT), timeout=timeout
        )
        connect = (
            f"CONNECT {hostname}:{port} HTTP/1.1\r\n"
            f"Host: {hostname}:{port}\r\n\r\n"
        )
        proxy_sock.sendall(connect.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += proxy_sock.recv(4096)
        first_line = buf.split(b"\r\n")[0].decode()
        if not first_line.split()[1].startswith("2"):
            raise ConnectionError(f"Burp CONNECT tunnel failed: {first_line}")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE
        tls_sock = ctx.wrap_socket(proxy_sock, server_hostname=hostname)
        conn = http.client.HTTPConnection("_unused_")
        conn.sock = tls_sock
    else:
        conn = http.client.HTTPConnection(
            BURP_PROXY_HOST, BURP_PROXY_PORT, timeout=timeout
        )

    send_headers = {
        "Host": hostname if port in (80, 443) else f"{hostname}:{port}",
        **headers,
    }
    body_bytes = body.encode() if isinstance(body, str) else (body or None)

    conn.request(method, path, body=body_bytes, headers=send_headers)
    resp         = conn.getresponse()
    status       = resp.status
    resp_headers = dict(resp.getheaders())
    resp_body    = resp.read().decode("utf-8", errors="replace")
    conn.close()

    return status, resp_headers, resp_body


# ═══════════════════════════════════════════════════════════════════════════════
# Core MCP call_tool  — direct Burp internal connection (not via proxy)
# ═══════════════════════════════════════════════════════════════════════════════

def call_tool(tool_name, params=None):
    """
    Full MCP session lifecycle: open SSE → initialize → call tool → return result.

    Returns the raw JSON-RPC response dict.
    Raises RuntimeError on MCP error, TimeoutError on timeout.
    """
    if params is None:
        params = {}
    sse, session_url = open_session()
    _init_session(sse, session_url)
    _post(session_url, {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": params},
    })
    return _read_response(sse, 2)


def list_tools():
    """Return the tools/list result (27 tools from BApp v1.1.2)."""
    sse, session_url = open_session()
    _init_session(sse, session_url)
    _post(session_url, {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {},
    })
    return _read_response(sse, 2)


# ═══════════════════════════════════════════════════════════════════════════════
# High-level convenience helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _build_http1_content(method, path, hostname, headers, body):
    """Assemble a raw HTTP/1.1 request string for the 'content' field."""
    lines = [f"{method} {path} HTTP/1.1", f"Host: {hostname}"]
    for k, v in headers.items():
        if k.lower() == "host":
            continue
        lines.append(f"{k}: {v}")
    if body:
        lines.append(f"Content-Length: {len(body.encode())}")
    lines.append("")        # blank line
    lines.append(body or "")
    return "\r\n".join(lines)


def send_http1(hostname, port, https, method, path, headers=None, body=""):
    """
    Send an HTTP/1.1 request through Burp MCP and return the response text.
    Does NOT go through proxy — use proxy_request() if you want History entries.
    """
    if headers is None:
        headers = {}
    content = _build_http1_content(method, path, hostname, headers, body)
    result  = call_tool("send_http1_request", {
        "content":        content,
        "targetHostname": hostname,
        "targetPort":     port,
        "usesHttps":      https,
    })
    return _extract_text(result)


def send_http2(hostname, port, https, method, path, headers=None, body=""):
    """
    Send an HTTP/2 request through Burp MCP and return the response text.
    Does NOT go through proxy — use proxy_request() if you want History entries.
    """
    if headers is None:
        headers = {}
    pseudo = {
        ":method":    method,
        ":path":      path,
        ":scheme":    "https" if https else "http",
        ":authority": hostname,
    }
    result = call_tool("send_http2_request", {
        "pseudoHeaders": pseudo,
        "headers":       headers,
        "requestBody":   body,
        "targetHostname": hostname,
        "targetPort":    port,
        "usesHttps":     https,
    })
    return _extract_text(result)


def repeater_tab(hostname, port, https, method, path, headers=None, body="",
                 tab_name=None):
    """Create an HTTP/1.1 Repeater tab in Burp for manual replay."""
    if headers is None:
        headers = {}
    if tab_name is None:
        tab_name = f"{method} {hostname}{path}"
    content = _build_http1_content(method, path, hostname, headers, body)
    result  = call_tool("create_repeater_tab", {
        "tabName":        tab_name,
        "content":        content,
        "targetHostname": hostname,
        "targetPort":     port,
        "usesHttps":      https,
    })
    return _extract_text(result)


def repeater_tab_http2(hostname, port, https, method, path, headers=None,
                       body="", tab_name=None):
    """Create an HTTP/2 Repeater tab in Burp for manual replay."""
    if headers is None:
        headers = {}
    if tab_name is None:
        tab_name = f"H2 {method} {hostname}{path}"
    pseudo = {
        ":method":    method,
        ":path":      path,
        ":scheme":    "https" if https else "http",
        ":authority": hostname,
    }
    result = call_tool("create_repeater_tab_http2", {
        "tabName":       tab_name,
        "pseudoHeaders": pseudo,
        "headers":       headers,
        "requestBody":   body,
        "targetHostname": hostname,
        "targetPort":    port,
        "usesHttps":     https,
    })
    return _extract_text(result)


def _parse_history_text(text):
    """Parse newline-delimited JSON from Burp MCP tool response."""
    items = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return items


def _extract_host(request_text):
    """Extract Host header value from a raw HTTP request string."""
    for line in request_text.split("\r\n"):
        if line.lower().startswith("host:"):
            return line.split(":", 1)[1].strip()
    return ""


def _filter_by_host(items, domain):
    """
    Client-side filter: keep only items where the Host header matches the domain.
    Matches the domain itself and any subdomain (*.domain).
    """
    filtered = []
    for item in items:
        host = _extract_host(item.get("request", ""))
        if host == domain or host.endswith("." + domain):
            filtered.append(item)
    return filtered


def _fetch_history_batch(count, offset=0, regex=None):
    """Single MCP call to fetch a batch of proxy history items."""
    if regex:
        result = call_tool("get_proxy_http_history_regex", {
            "count": count, "offset": offset, "regex": regex,
        })
    else:
        result = call_tool("get_proxy_http_history", {
            "count": count, "offset": offset,
        })
    return _parse_history_text(_extract_text(result))


def _fetch_history_latest_batch(count, offset=0, regex=None, max_length=None):
    """Fetch a batch from the _latest fork (native newest-first, offset=0 = newest)."""
    params = {"count": count, "offset": offset}
    if regex:
        params["regex"] = regex
    if max_length is not None:
        params["maxLength"] = max_length
    result = call_tool("get_proxy_http_history_latest", params)
    return _parse_history_text(_extract_text(result))


def get_proxy_history(count=100, offset=0, regex=None, newest_first=True, host_filter=None):
    """
    Pull Burp proxy history — optimised for heavy use.
    Returns list of history item dicts (each has 'request', 'response' keys).

    Args:
        count:   Number of entries to return (default 100).
        offset:  Starting offset. For newest_first=True: offset=0 = newest entry.
                 For newest_first=False: offset=0 = oldest entry.
        regex:   Server-side regex filter (uses get_proxy_http_history_regex).
                 WARNING: regex matches full request text including Referer headers.
                 Use host_filter for domain-specific filtering instead.
        newest_first: If True (default), use the _latest fork for O(log N) access
                     to recent entries. No brute-force from offset 0.
        host_filter: Client-side Host header filter. Only return requests where the
                     Host header matches this domain (e.g. "api.target.com").
                     Matches exact domain AND subdomains (*.domain). MUCH more precise
                     than regex for domain-specific searches.

    Returns:
        List of history item dicts, each containing at minimum 'request' and 'response' keys.
    """
    if newest_first:
        # Use _latest fork — native newest-first, offset=0 = most recent
        # This avoids brute-forcing ALL entries from offset 0
        BATCH = min(count, 100)  # conservative batch size for responsiveness
        all_items = []
        off = 0

        while len(all_items) < count:
            batch = _fetch_history_latest_batch(BATCH, off, regex)
            if not batch:
                break
            all_items.extend(batch)
            if len(batch) < BATCH:
                break
            off += len(batch)

        # Client-side host filtering
        if host_filter:
            all_items = _filter_by_host(all_items, host_filter)

        return all_items[:count]

    else:
        items = _fetch_history_batch(count, offset, regex)
        if host_filter:
            items = _filter_by_host(items, host_filter)
        return items


def get_scanner_issues(count=50, offset=0):
    """Pull Burp scanner issues. Returns list of issue dicts."""
    result = call_tool("get_scanner_issues", {"count": count, "offset": offset})
    text   = _extract_text(result)
    issues = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            issues.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return issues


def generate_collaborator_payload(custom_data=""):
    """
    Generate a Burp Collaborator OOB payload.

    Returns a dict with keys:
        url        — full hostname e.g. "abc123.oastify.com"
        payload_id — id portion    e.g. "abc123"
        server     — collaborator server e.g. "oastify.com"

    Example
    -------
    p = generate_collaborator_payload()
    print(p["url"])   # abc123.oastify.com
    """
    args = {}
    if custom_data:
        args["customData"] = custom_data
    result = call_tool("generate_collaborator_payload", args)
    text = _extract_text(result).strip()
    # Parse the structured text response:
    #   Payload: <hostname>
    #   Payload ID: <id>
    #   Collaborator server: <server>
    import re
    url_m    = re.search(r"^Payload:\s*(.+)$",              text, re.MULTILINE)
    id_m     = re.search(r"^Payload ID:\s*(.+)$",           text, re.MULTILINE)
    srv_m    = re.search(r"^Collaborator server:\s*(.+)$",  text, re.MULTILINE)
    return {
        "url":        url_m.group(1).strip()  if url_m  else text,
        "payload_id": id_m.group(1).strip()   if id_m   else "",
        "server":     srv_m.group(1).strip()  if srv_m  else "oastify.com",
        "raw":        text,
    }


def get_collaborator_interactions(payload_id=None):
    """
    Poll for DNS/HTTP/SMTP callbacks on Burp Collaborator.

    BApp v1.1.2: get_collaborator_interactions takes NO arguments — it returns
    ALL interactions for every payload generated in the current Burp session.
    The payload_id parameter is kept for API compatibility but is NOT sent to Burp.

    Returns raw text (newline-separated JSON interaction objects).
    """
    result = call_tool("get_collaborator_interactions", {})
    return _extract_text(result)


# ═══════════════════════════════════════════════════════════════════════════════
# Config & State tools  (output/edit project/user options, engine state, intercept, editor)
# ═══════════════════════════════════════════════════════════════════════════════

def output_project_options():
    """Export Burp project-level configuration as JSON."""
    return _extract_text(call_tool("output_project_options", {}))


def output_user_options():
    """Export Burp user-level configuration as JSON."""
    return _extract_text(call_tool("output_user_options", {}))


def set_task_execution_engine_state(running=True):
    """Pause (running=False) or resume (running=True) the Burp scanner engine."""
    return _extract_text(call_tool("set_task_execution_engine_state", {"running": running}))


def set_proxy_intercept_state(intercepting=True):
    """Enable or disable Burp proxy intercept."""
    return _extract_text(call_tool("set_proxy_intercept_state", {"intercepting": intercepting}))


def get_active_editor_contents():
    """Read the text from Burp's currently focused message editor."""
    return _extract_text(call_tool("get_active_editor_contents", {}))


def set_active_editor_contents(text):
    """Set the text in Burp's currently focused message editor (if editable)."""
    return _extract_text(call_tool("set_active_editor_contents", {"text": text}))


# ═══════════════════════════════════════════════════════════════════════════════
# Organizer tools
# ═══════════════════════════════════════════════════════════════════════════════

def _fetch_paginated_batch(tool_name, count=100, offset=0, regex=None):
    """Fetch a batch of paginated items from any Burp paginated tool."""
    params = {"count": count, "offset": offset}
    if regex is not None:
        params["regex"] = regex
    result = call_tool(tool_name, params)
    return _parse_history_text(_extract_text(result))


def get_organizer_items(count=100, offset=0):
    """Pull Burp Organizer items. Returns list of item dicts."""
    return _fetch_paginated_batch("get_organizer_items", count, offset)


def get_organizer_items_regex(count=100, offset=0, regex=""):
    """Pull Burp Organizer items matching a regex filter."""
    return _fetch_paginated_batch("get_organizer_items_regex", count, offset, regex)


def get_proxy_websocket_history(count=100, offset=0):
    """Pull Burp proxy WebSocket history. Returns list of item dicts."""
    return _fetch_paginated_batch("get_proxy_websocket_history", count, offset)


def get_proxy_websocket_history_regex(count=100, offset=0, regex=""):
    """Pull Burp proxy WebSocket history matching a regex filter."""
    return _fetch_paginated_batch("get_proxy_websocket_history_regex", count, offset, regex)


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _extract_text(result):
    """Pull the text content from a tool call result, or raise on error."""
    if "error" in result:
        raise RuntimeError(f"Burp MCP error: {result['error']}")
    r       = result.get("result", {})
    is_err  = r.get("isError", False)
    content = r.get("content", [])
    text    = "\n".join(
        item.get("text", "")
        for item in (content if isinstance(content, list) else [])
        if item.get("type") == "text"
    )
    if is_err:
        raise RuntimeError(f"Burp MCP tool error: {text}")
    return text


def print_result(result):
    """Pretty-print a raw tool call result dict."""
    if "error" in result:
        print(f"ERROR: {result['error']}", file=sys.stderr)
        sys.exit(1)
    content = result.get("result", {}).get("content", result.get("result", {}))
    if isinstance(content, list):
        for item in content:
            if item.get("type") == "text":
                print(item["text"])
    else:
        print(json.dumps(content, indent=2))


# ═══════════════════════════════════════════════════════════════════════════════
# CLI entry point
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "--list-tools":
        result = list_tools()
        tools  = result.get("result", {}).get("tools", [])
        print(f"\nBurp MCP tools ({len(tools)} available):\n")
        for t in tools:
            props = list(t.get("inputSchema", {}).get("properties", {}).keys())
            req   = t.get("inputSchema", {}).get("required", [])
            print(f"  {t['name']:<40s}  required={req}")
        sys.exit(0)

    if cmd == "--proxy-get":
        if len(sys.argv) < 3:
            print("Usage: burp_mcp_client.py --proxy-get <url> [json_headers]",
                  file=sys.stderr)
            sys.exit(1)
        url  = sys.argv[2]
        hdrs = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        hdrs.setdefault("User-Agent", "BobSecurityOperator/2.0")
        hdrs.setdefault("Accept", "*/*")
        try:
            status, resp_headers, body = proxy_request(url, "GET", hdrs)
            print(f"HTTP {status}")
            for k, v in resp_headers.items():
                print(f"  {k}: {v}")
            print()
            print(body[:4000])
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    if cmd == "--proxy-history":
        newest      = "--newest" in sys.argv
        first_party = "--first-party" in sys.argv
        # Parse --scope <domain> for custom host filtering
        scope_domain = None
        if "--scope" in sys.argv:
            idx = sys.argv.index("--scope")
            if idx + 1 < len(sys.argv):
                scope_domain = sys.argv[idx + 1]
        # Remove flags from argv for positional parsing
        flags = {"--newest", "--first-party"}
        if "--scope" in sys.argv:
            flags.add("--scope")
            flags.add(sys.argv[sys.argv.index("--scope") + 1])
        positional = [a for a in sys.argv[2:] if a not in flags]
        count  = int(positional[0]) if len(positional) > 0 else 50
        regex  = positional[1] if len(positional) > 1 else None
        try:
            domain = scope_domain or ("audemarspiguet.com" if first_party else None)
            if newest and domain:
                # Fetch ALL entries, filter for first-party, then take last N
                items = get_proxy_history(count=100_000, regex=regex, newest_first=True)
                items = _filter_by_host(items, domain)
                items = items[:count]  # already newest-first from get_proxy_history
            elif newest:
                items = get_proxy_history(count=count, regex=regex, newest_first=True)
            else:
                items = get_proxy_history(count=max(count, 10_000) if domain else count,
                                         regex=regex, newest_first=False)
                if domain:
                    items = _filter_by_host(items, domain)
                    items = items[-count:] if len(items) > count else items
            label_parts = []
            if newest:      label_parts.append("newest first")
            if domain:      label_parts.append(f"first-party ({domain})")
            label = f" ({', '.join(label_parts)})" if label_parts else ""
            print(f"\n{len(items)} history items{label}:\n")
            for item in items:
                req_line  = item.get("request", "").split("\r\n")[0]
                resp_line = item.get("response", "").split("\r\n")[0]
                host = _extract_host(item.get("request", ""))
                st = resp_line.split(" ")[1] if " " in resp_line else "???"
                icon = {"200": "✅", "201": "✅", "401": "🔒", "403": "🔒",
                        "404": "❌", "500": "💥"}.get(st, "⚠️ ")
                print(f"  {icon} [{st}]  {host}  {req_line}")
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    # Generic tool call: python3 burp_mcp_client.py <tool_name> [json_params]
    tool   = cmd
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        result = call_tool(tool, params)
        print_result(result)
    except TimeoutError as e:
        print(f"TIMEOUT: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
