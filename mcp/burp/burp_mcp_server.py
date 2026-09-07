#!/usr/bin/env python3
"""
Burp Suite MCP Server — stdio transport for OpenCode
=====================================================
Speaks the MCP stdio protocol (JSON-RPC 2.0 over stdin/stdout).
Delegates all tool calls to burp_mcp_client.py under the hood.

Exposed tools (36 total — 28 official + 8 from RamanMG/Burp-MCP-Unrestricted fork)
-------------------------------------------------------------------
  === Standard (28) ===
  proxy_request              — Route HTTP through Burp proxy → Proxy > HTTP History
  send_http1_request         — Direct internal HTTP/1.1
  send_http2_request         — Direct internal HTTP/2
  send_to_intruder           — Send HTTP request to Intruder
  create_repeater_tab        — Create HTTP/1.1 Repeater tab
  create_repeater_tab_http2  — Create HTTP/2 Repeater tab
  url_encode / url_decode    — URL encode/decode strings
  base64_encode / base64_decode — Base64 encode/decode
  generate_random_string     — Generate random string
  get_proxy_http_history     — Proxy HTTP history (supports newest_first)
  get_proxy_http_history_regex — Proxy history with regex (supports newest_first)
  get_proxy_websocket_history — Proxy WebSocket history
  get_proxy_websocket_history_regex — WebSocket history with regex
  get_organizer_items        — Burp Organizer items
  get_organizer_items_regex  — Organizer items with regex
  get_scanner_issues         — Burp scanner findings
  generate_collaborator_payload — Generate OOB payload URL
  get_collaborator_interactions — Poll for DNS/HTTP/SMTP callbacks
  output_project_options     — Export project config as JSON
  output_user_options        — Export user config as JSON
  set_task_execution_engine_state — Pause/resume scanner
  set_proxy_intercept_state  — Enable/disable intercept
  get_active_editor_contents — Read active editor text
  set_active_editor_contents — Write to active editor

  === Unrestricted fork (8) — v1.3.0 ===
  get_proxy_http_history_latest — Proxy history newest-first, supports maxLength=0 for no truncation
  get_site_map              — Read Burp's target site map (discovered URLs)
  active_scan_url           — Start an active audit against a URL (Professional)
  crawl_url                 — Start a crawl from seed URLs (Professional)
  repeater_send             — Click Send on a Repeater tab
  repeater_read             — Read the visible request/response editors
  repeater_rename           — Rename a Repeater sub-tab
  swing_dump                — Dump Burp's Swing UI tree (diagnostic)

Usage
-----
  python3 burp_mcp_server.py

Reads JSON-RPC 2.0 from stdin, writes to stdout.
Designed to be configured as an OpenCode MCP local server.
"""

import json
import sys
import traceback
import time

# ── Import burp_mcp_client ────────────────────────────────────────────────
# HACK: add lib/ to sys.path so imports work from anywhere
import os.path as _osp
_lib_dir = _osp.dirname(_osp.abspath(__file__))
if _lib_dir not in sys.path:
    sys.path.insert(0, _lib_dir)

import burp_mcp_client as burp


# ═══════════════════════════════════════════════════════════════════════════
# Tool schemas  (MCP inputSchema format)
# ═══════════════════════════════════════════════════════════════════════════

TOOLS = [
    {
        "name": "proxy_request",
        "description": "Route HTTP request through Burp proxy listener (127.0.0.1:8080). "
                       "Appears in Burp Proxy > HTTP History — use this for all active testing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url":    {"type": "string", "description": "Full URL (http/https)"},
                "method": {"type": "string", "description": "HTTP method, default GET",
                           "default": "GET"},
                "headers": {"type": "object",
                            "description": "Optional headers dict, e.g. {\"Authorization\": \"Bearer ...\"}",
                            "default": {}},
                "body":   {"type": "string", "description": "Request body", "default": ""},
                "timeout": {"type": "number", "description": "Timeout in seconds", "default": 30},
            },
            "required": ["url"],
        },
    },
    {
        "name": "send_http1_request",
        "description": "Send an HTTP/1.1 request directly through Burp (internal). "
                       "Does NOT appear in Proxy History by default — use create_repeater_tab to capture.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content":        {"type": "string",
                                   "description": "Full raw HTTP/1.1 request string"},
                "targetHostname": {"type": "string"},
                "targetPort":     {"type": "integer"},
                "usesHttps":      {"type": "boolean"},
            },
            "required": ["content", "targetHostname", "targetPort", "usesHttps"],
        },
    },
    {
        "name": "send_http2_request",
        "description": "Send an HTTP/2 request directly through Burp (internal).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pseudoHeaders": {"type": "object",
                                  "description": "HTTP/2 pseudo-headers e.g. {\":method\": \"GET\"}"},
                "headers":       {"type": "object", "description": "Regular headers"},
                "requestBody":   {"type": "string", "description": "Request body"},
                "targetHostname": {"type": "string"},
                "targetPort":     {"type": "integer"},
                "usesHttps":      {"type": "boolean"},
            },
            "required": ["pseudoHeaders", "headers", "requestBody",
                         "targetHostname", "targetPort", "usesHttps"],
        },
    },
    {
        "name": "create_repeater_tab",
        "description": "Create an HTTP/1.1 Repeater tab in Burp for manual replay.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content":        {"type": "string", "description": "Full raw HTTP/1.1 request"},
                "targetHostname": {"type": "string"},
                "targetPort":     {"type": "integer"},
                "usesHttps":      {"type": "boolean"},
                "tabName":        {"type": "string", "description": "Tab label", "default": ""},
            },
            "required": ["content", "targetHostname", "targetPort", "usesHttps"],
        },
    },
    {
        "name": "send_to_intruder",
        "description": "Send an HTTP request to Burp Intruder with optional tab name.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content":        {"type": "string", "description": "Full raw HTTP request string"},
                "targetHostname": {"type": "string"},
                "targetPort":     {"type": "integer"},
                "usesHttps":      {"type": "boolean"},
                "tabName":        {"type": "string", "default": ""},
            },
            "required": ["content", "targetHostname", "targetPort", "usesHttps"],
        },
    },
    {
        "name": "create_repeater_tab_http2",
        "description": "Create an HTTP/2 Repeater tab in Burp.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pseudoHeaders": {"type": "object"},
                "headers":       {"type": "object"},
                "requestBody":   {"type": "string"},
                "targetHostname": {"type": "string"},
                "targetPort":     {"type": "integer"},
                "usesHttps":      {"type": "boolean"},
                "tabName":        {"type": "string", "default": ""},
            },
            "required": ["pseudoHeaders", "headers", "requestBody",
                         "targetHostname", "targetPort", "usesHttps"],
        },
    },
    {
        "name": "get_proxy_http_history",
        "description": "Pull Burp proxy HTTP history. Returns JSON with 'request' and 'response' for each entry. "
                       "Defaults to newest-first — use host_filter for domain-specific searches. "
                       "AVOID get_proxy_http_history_regex for domain searches — regex matches Referer "
                       "headers from third-party trackers, flooding results with noise.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":        {"type": "integer", "description": "Max items to return", "default": 100},
                "offset":       {"type": "integer", "description": "Offset from end (0 = newest). Ignored when newest_first=true", "default": 0},
                "newest_first": {"type": "boolean", "description": "True = newest-first (default). False = oldest-first.", "default": True},
                "host_filter":  {"type": "string", "description": "Only return requests to this domain (e.g. 'www.audemarspiguet.com'). Matches *.domain too. Use this instead of regex for domain searches."},
            },
            "required": [],
        },
    },
    {
        "name": "get_proxy_http_history_regex",
        "description": "Burp proxy history with regex. WARNING: regex matches FULL request text "
                       "including Referer headers — 'audemarspiguet.com' also matches Google/TikTok "
                       "tracking pixels. For domain searches, use get_proxy_http_history with "
                       "host_filter='domain.com' instead (newest-first is default). "
                       "Use this ONLY for specific patterns: 'login-token', 'Bearer ', 'Authorization'.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":        {"type": "integer", "default": 100},
                "offset":       {"type": "integer", "default": 0},
                "regex":        {"type": "string", "description": "Use SPECIFIC patterns: 'login-token', 'Bearer ', not domain names."},
                "newest_first": {"type": "boolean", "description": "True = newest-first (default). False = oldest-first.", "default": True},
                "host_filter":  {"type": "string", "description": "Optional: also filter to this domain."},
            },
            "required": ["regex"],
        },
    },
    {
        "name": "get_scanner_issues",
        "description": "Pull Burp Scanner issues.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":  {"type": "integer", "default": 50},
                "offset": {"type": "integer", "default": 0},
            },
            "required": [],
        },
    },
    {
        "name": "generate_collaborator_payload",
        "description": "Generate a Burp Collaborator OOB payload URL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customData": {"type": "string", "description": "Optional custom data", "default": ""},
            },
            "required": [],
        },
    },
    {
        "name": "get_collaborator_interactions",
        "description": "Poll Burp Collaborator for DNS/HTTP/SMTP callbacks. "
                       "Returns ALL interactions for all payloads in current session.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "url_encode",
        "description": "URL-encode the input string.",
        "inputSchema": {
            "type": "object",
            "properties": {"content": {"type": "string", "description": "String to encode"}},
            "required": ["content"],
        },
    },
    {
        "name": "url_decode",
        "description": "URL-decode the input string.",
        "inputSchema": {
            "type": "object",
            "properties": {"content": {"type": "string", "description": "String to decode"}},
            "required": ["content"],
        },
    },
    {
        "name": "base64_encode",
        "description": "Base64-encode the input string.",
        "inputSchema": {
            "type": "object",
            "properties": {"content": {"type": "string", "description": "String to encode"}},
            "required": ["content"],
        },
    },
    {
        "name": "base64_decode",
        "description": "Base64-decode the input string.",
        "inputSchema": {
            "type": "object",
            "properties": {"content": {"type": "string", "description": "String to decode"}},
            "required": ["content"],
        },
    },
    {
        "name": "generate_random_string",
        "description": "Generate a random string of specified length and character set.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "length":        {"type": "integer", "description": "Length of random string"},
                "characterSet":  {"type": "string", "description": "Character set (e.g. 'alphanumeric', 'alpha', 'numeric')"},
            },
            "required": ["length", "characterSet"],
        },
    },
    {
        "name": "output_project_options",
        "description": "Export Burp project-level configuration as JSON. Use to inspect current project settings schema.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "output_user_options",
        "description": "Export Burp user-level configuration as JSON. Use to inspect current user settings schema.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "set_task_execution_engine_state",
        "description": "Pause or resume Burp's automated task execution engine (scanner, etc.).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "running": {"type": "boolean", "description": "True to resume, False to pause"},
            },
            "required": ["running"],
        },
    },
    {
        "name": "set_proxy_intercept_state",
        "description": "Enable or disable Burp Proxy Intercept.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "intercepting": {"type": "boolean", "description": "True to enable intercept, False to disable"},
            },
            "required": ["intercepting"],
        },
    },
    {
        "name": "get_active_editor_contents",
        "description": "Read the text from Burp's currently focused message editor. Returns '<No active editor>' if no editor is focused.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "set_active_editor_contents",
        "description": "Set the text in Burp's currently focused message editor. Returns error if editor is not editable.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to set in the active editor"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "get_organizer_items",
        "description": "List items stored in Burp Organizer.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":  {"type": "integer", "default": 100},
                "offset": {"type": "integer", "default": 0},
            },
            "required": [],
        },
    },
    {
        "name": "get_organizer_items_regex",
        "description": "List Burp Organizer items matching a regex filter.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":  {"type": "integer", "default": 100},
                "offset": {"type": "integer", "default": 0},
                "regex":  {"type": "string", "description": "Filter regex"},
            },
            "required": ["regex"],
        },
    },
    {
        "name": "get_proxy_websocket_history",
        "description": "List items from Burp proxy WebSocket history.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":  {"type": "integer", "default": 100},
                "offset": {"type": "integer", "default": 0},
            },
            "required": [],
        },
    },
    {
        "name": "get_proxy_websocket_history_regex",
        "description": "List Burp proxy WebSocket history items matching a regex filter.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":  {"type": "integer", "default": 100},
                "offset": {"type": "integer", "default": 0},
                "regex":  {"type": "string", "description": "Filter regex"},
            },
            "required": ["regex"],
        },
    },
    # ── Unrestricted fork tools (8) — v1.3.0 ──
    {
        "name": "get_proxy_http_history_latest",
        "description": "Pull Burp proxy HTTP history newest-first (Unrestricted fork). "
                       "offset=0 returns the most recent request. "
                       "maxLength=0 disables the 5000-char truncation for full responses. "
                       "PREFERRED over get_proxy_http_history for recent traffic.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":     {"type": "integer", "description": "Max items to return", "default": 100},
                "offset":    {"type": "integer", "description": "Offset from end (0 = newest)", "default": 0},
                "maxLength": {"type": "integer", "description": "Max response body length. 0 = no truncation", "default": 5000},
                "host_filter": {"type": "string", "description": "Only return requests matching this domain"},
                "regex":     {"type": "string", "description": "Regex filter over request/response text"},
            },
            "required": [],
        },
    },
    {
        "name": "get_site_map",
        "description": "Read Burp's target site map — discovered URL inventory "
                       "including spidered/crawled URLs with no response yet. "
                       "(Unrestricted fork) Supports host_filter and regex.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count":     {"type": "integer", "description": "Max items to return", "default": 100},
                "offset":    {"type": "integer", "description": "Starting offset", "default": 0},
                "host":      {"type": "string", "description": "Filter by host (e.g. 'example.com')"},
                "regex":     {"type": "string", "description": "Filter URLs matching regex"},
                "maxLength": {"type": "integer", "description": "Max response body length. 0 = no truncation", "default": 5000},
            },
            "required": [],
        },
    },
    {
        "name": "active_scan_url",
        "description": "Start an active Burp Scanner audit against a URL. (Unrestricted fork, Professional only)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url":    {"type": "string", "description": "URL to scan"},
                "insertionPoint": {"type": "object", "description": "Optional custom insertion point"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "crawl_url",
        "description": "Start a crawl from seed URLs. (Unrestricted fork, Professional only)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "seedUrls":  {"type": "array", "items": {"type": "string"}, "description": "Seed URLs to crawl"},
            },
            "required": ["seedUrls"],
        },
    },
    {
        "name": "repeater_send",
        "description": "Click Send on a Repeater tab, triggering the request and capturing the response. "
                       "(Unrestricted fork) Use after create_repeater_tab / create_repeater_tab_http2.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "buttonIndex": {"type": "integer", "description": "Which send button to click (0 = first/send-all)", "default": 0},
                "buttonLabel": {"type": "string", "description": "Alternative: click button with this label text"},
                "tabName":     {"type": "string", "description": "Target a specific Repeater sub-tab by name"},
            },
            "required": [],
        },
    },
    {
        "name": "repeater_read",
        "description": "Read the visible request/response editors of the active Repeater tab. "
                       "(Unrestricted fork) Returns both request and response as raw strings.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "maxLength": {"type": "integer", "description": "Max response body length", "default": 5000},
            },
            "required": [],
        },
    },
    {
        "name": "repeater_rename",
        "description": "Rename a Repeater sub-tab. (Unrestricted fork)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "fromName": {"type": "string", "description": "Current tab name"},
                "toName":   {"type": "string", "description": "New tab name"},
            },
            "required": ["fromName", "toName"],
        },
    },
    {
        "name": "swing_dump",
        "description": "Dump Burp's Swing UI component tree. (Unrestricted fork, diagnostic) "
                       "Useful for mapping Repeater tab indices for repeater_send.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "maxDepth":    {"type": "integer", "description": "Max tree depth", "default": -1},
                "maxLength":   {"type": "integer", "description": "Max response length per item", "default": 5000},
                "showingOnly": {"type": "boolean", "description": "Only show visible components", "default": False},
            },
            "required": [],
        },
    },
]


# ═══════════════════════════════════════════════════════════════════════════
# Tool dispatch
# ═══════════════════════════════════════════════════════════════════════════

def _dispatch(tool_name: str, args: dict) -> dict:
    """Call the requested tool with args and return {'content': [...], 'isError': bool}."""

    try:
        if tool_name == "proxy_request":
            url     = args["url"]
            method  = args.get("method", "GET")
            headers = args.get("headers", {})
            body    = args.get("body", "")
            timeout = args.get("timeout", 30)
            status, resp_headers, body_text = burp.proxy_request(url, method, headers, body, timeout)
            lines = [f"HTTP {status}"]
            for k, v in resp_headers.items():
                lines.append(f"  {k}: {v}")
            lines.append("")
            lines.append(body_text[:50000])  # cap at 50KB
            return {"content": [{"type": "text", "text": "\n".join(lines)}], "isError": False}

        elif tool_name == "send_http1_request":
            result = burp.call_tool("send_http1_request", args)
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "send_http2_request":
            result = burp.call_tool("send_http2_request", args)
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "create_repeater_tab":
            content        = args["content"]
            hostname       = args["targetHostname"]
            port           = args["targetPort"]
            https          = args["usesHttps"]
            tab_name       = args.get("tabName", content.split("\r\n")[0] if "\r\n" in content else content[:40])
            result = burp.call_tool("create_repeater_tab", {
                "tabName":        tab_name,
                "content":        content,
                "targetHostname": hostname,
                "targetPort":     port,
                "usesHttps":      https,
            })
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "send_to_intruder":
            result = burp.call_tool("send_to_intruder", args)
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "create_repeater_tab_http2":
            result = burp.call_tool("create_repeater_tab_http2", args)
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "get_proxy_http_history":
            count        = args.get("count", 100)
            offset       = args.get("offset", 0)
            newest_first = args.get("newest_first", True)
            host_filter  = args.get("host_filter")
            items        = burp.get_proxy_history(count, offset, newest_first=newest_first, host_filter=host_filter)
            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        elif tool_name == "get_proxy_http_history_regex":
            count        = args.get("count", 100)
            offset       = args.get("offset", 0)
            regex        = args.get("regex", "")
            newest_first = args.get("newest_first", True)
            host_filter  = args.get("host_filter")
            items        = burp.get_proxy_history(count, offset, regex, newest_first=newest_first, host_filter=host_filter)
            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        elif tool_name == "get_scanner_issues":
            count  = args.get("count", 50)
            offset = args.get("offset", 0)
            issues = burp.get_scanner_issues(count, offset)
            return {"content": [{"type": "text", "text": json.dumps(issues, indent=2)}], "isError": False}

        elif tool_name == "generate_collaborator_payload":
            custom_data = args.get("customData", "")
            payload = burp.generate_collaborator_payload(custom_data)
            # Return structured JSON so the agent can parse url / payload_id / server
            return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}], "isError": False}

        elif tool_name == "get_collaborator_interactions":
            text = burp.get_collaborator_interactions()
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "url_encode":
            result = burp.call_tool("url_encode", {"content": args["content"]})
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "url_decode":
            result = burp.call_tool("url_decode", {"content": args["content"]})
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "base64_encode":
            result = burp.call_tool("base64_encode", {"content": args["content"]})
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "base64_decode":
            result = burp.call_tool("base64_decode", {"content": args["content"]})
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "generate_random_string":
            result = burp.call_tool("generate_random_string", {
                "length": args["length"],
                "characterSet": args["characterSet"],
            })
            text = burp._extract_text(result)
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "output_project_options":
            text = burp.output_project_options()
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "output_user_options":
            text = burp.output_user_options()
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "set_task_execution_engine_state":
            text = burp.set_task_execution_engine_state(args["running"])
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "set_proxy_intercept_state":
            text = burp.set_proxy_intercept_state(args["intercepting"])
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "get_active_editor_contents":
            text = burp.get_active_editor_contents()
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "set_active_editor_contents":
            text = burp.set_active_editor_contents(args["text"])
            return {"content": [{"type": "text", "text": text}], "isError": False}

        elif tool_name == "get_organizer_items":
            count  = args.get("count", 100)
            offset = args.get("offset", 0)
            items  = burp.get_organizer_items(count, offset)
            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        elif tool_name == "get_organizer_items_regex":
            count  = args.get("count", 100)
            offset = args.get("offset", 0)
            regex  = args.get("regex", "")
            items  = burp.get_organizer_items_regex(count, offset, regex)
            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        elif tool_name == "get_proxy_websocket_history":
            count  = args.get("count", 100)
            offset = args.get("offset", 0)
            items  = burp.get_proxy_websocket_history(count, offset)
            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        elif tool_name == "get_proxy_websocket_history_regex":
            count  = args.get("count", 100)
            offset = args.get("offset", 0)
            regex  = args.get("regex", "")
            items  = burp.get_proxy_websocket_history_regex(count, offset, regex)
            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        # ── Unrestricted fork — 8 new tools ──
        elif tool_name == "get_proxy_http_history_latest":
            params = {"count": args.get("count", 100), "offset": args.get("offset", 0)}
            host_filter = args.get("host_filter")

            if args.get("maxLength") is not None:
                params["maxLength"] = args["maxLength"]
            if args.get("regex"):
                params["regex"] = args["regex"]

            result = burp.call_tool("get_proxy_http_history_latest", params)
            text = burp._extract_text(result)

            # Parse newline-delimited JSON into a proper list
            items = []
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

            # Proper host_filter (same logic as burp_mcp_client._filter_by_host)
            if host_filter:
                filtered = []
                for item in items:
                    request_raw = item.get("request", "")
                    host = ""
                    for hdr in request_raw.split("\r\n"):
                        if hdr.lower().startswith("host:"):
                            host = hdr.split(":", 1)[1].strip()
                            break
                    if host == host_filter or host.endswith("." + host_filter):
                        filtered.append(item)
                items = filtered

            return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}], "isError": False}

        elif tool_name == "get_site_map":
            params = {"count": args.get("count", 100), "offset": args.get("offset", 0)}
            if args.get("host"):
                params["host"] = args["host"]
            if args.get("regex"):
                params["regex"] = args["regex"]
            if args.get("maxLength") is not None:
                params["maxLength"] = args["maxLength"]
            result = burp.call_tool("get_site_map", params)
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        elif tool_name == "active_scan_url":
            params = {"url": args["url"]}
            if args.get("insertionPoint"):
                params["insertionPoint"] = args["insertionPoint"]
            result = burp.call_tool("active_scan_url", params)
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        elif tool_name == "crawl_url":
            result = burp.call_tool("crawl_url", {
                "seedUrls": args["seedUrls"],
            })
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        elif tool_name == "repeater_send":
            params = {}
            if args.get("buttonIndex") is not None:
                params["buttonIndex"] = args["buttonIndex"]
            if args.get("buttonLabel"):
                params["buttonLabel"] = args["buttonLabel"]
            if args.get("tabName"):
                params["tabName"] = args["tabName"]
            result = burp.call_tool("repeater_send", params)
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        elif tool_name == "repeater_read":
            params = {}
            if args.get("maxLength") is not None:
                params["maxLength"] = args["maxLength"]
            result = burp.call_tool("repeater_read", params)
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        elif tool_name == "repeater_rename":
            result = burp.call_tool("repeater_rename", {
                "fromName": args["fromName"],
                "toName":   args["toName"],
            })
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        elif tool_name == "swing_dump":
            params = {}
            if args.get("maxDepth") is not None:
                params["maxDepth"] = args["maxDepth"]
            if args.get("maxLength") is not None:
                params["maxLength"] = args["maxLength"]
            if args.get("showingOnly") is not None:
                params["showingOnly"] = args["showingOnly"]
            result = burp.call_tool("swing_dump", params)
            return {"content": [{"type": "text", "text": burp._extract_text(result)}], "isError": False}

        else:
            return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}

    except TimeoutError as e:
        return {"content": [{"type": "text", "text": f"Burp MCP timeout: {e}\nCheck Burp is running with MCP BApp enabled at http://127.0.0.1:9876"}], "isError": True}
    except KeyError as e:
        return {"content": [{"type": "text", "text": f"Missing required argument: {e}"}], "isError": True}
    except Exception as e:
        return {"content": [{"type": "text", "text": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"}], "isError": True}


# ═══════════════════════════════════════════════════════════════════════════
# MCP stdio main loop
# ═══════════════════════════════════════════════════════════════════════════

def _send(msg: dict):
    """Write a JSON-RPC message to stdout, followed by newline."""
    line = json.dumps(msg, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main():
    """Read JSON-RPC 2.0 from stdin, process, write responses to stdout."""
    initialized = False
    req_id_counter = 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        req_id = msg.get("id")

        # ── initialize ──
        if method == "initialize":
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "experimental": {},
                        "prompts": {"listChanged": False},
                        "resources": {"subscribe": False, "listChanged": False},
                        "tools": {"listChanged": False},
                    },
                    "serverInfo": {
                        "name": "burp-mcp-server",
                        "version": "1.0.0",
                    },
                },
            })
            continue

        # ── notifications — no response ──
        if method == "notifications/initialized":
            initialized = True
            continue

        if method == "notifications/cancelled":
            continue

        # ── ping ──
        if method == "ping":
            _send({"jsonrpc": "2.0", "id": req_id, "result": {}})
            continue

        # ── tools/list ──
        if method == "tools/list":
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": TOOLS},
            })
            continue

        # ── tools/call ──
        if method == "tools/call":
            tool_name = msg.get("params", {}).get("name", "")
            arguments = msg.get("params", {}).get("arguments", {})
            result = _dispatch(tool_name, arguments)
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": result,
            })
            continue

        # ── shutdown ──
        if method == "shutdown":
            _send({"jsonrpc": "2.0", "id": req_id, "result": {}})
            break

        # ── Unknown method ──
        if req_id is not None:
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            })


if __name__ == "__main__":
    main()
