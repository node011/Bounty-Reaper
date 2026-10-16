#!/usr/bin/env python3
"""JS bundle recon — extract endpoints, routes, API paths, URLs and potential secrets
from JavaScript bundles (local files or URLs). Stdlib only; no curl needed.

This is the packaged helper behind the "bundle-first" hunting discipline: JS bundle
analysis was the single highest-yield activity in live hunts (full API maps from
main.js + grep), and previously the agent had to hand-roll greps because no bundled
recon existed.
"""

import json
import re
import ssl
import sys
import urllib.request

DEFAULT_TIMEOUT = 30
MAX_BYTES = 8 * 1024 * 1024

PATTERNS = {
    "api_paths": r"""(?=["'])/(?:api|v[0-9]|rest|gql|graphql|rpc|query|mutation)/[A-Za-z0-9_\-./{}:]{1,120}["']?""",
    "route_literals": r"""(?:path|route)\s*[:=]\s*["'](/[A-Za-z0-9_\-./:{}]{1,120})["']""",
    "graphql_ops": r"""(?:query|mutation|subscription)\s+[A-Za-z0-9_]{2,60}\s*[\(\{]""",
    "abs_urls": r"""https?://[A-Za-z0-9.\-_]+(?:\.[a-z]{2,24})(?::\d{2,5})?(?:/[A-Za-z0-9\-._~/?%&=,;#@!]*)?""",
    "relative_files": r"""(?=["'])/(?:[A-Za-z0-9_\-.]+/){0,6}[A-Za-z0-9_\-./]+\.(?:js|json|mjs|cjs|wasm|css|map)["']""",
    "config_keys": r"""(?:window|globalThis)\s*\.\s*(?:__?[A-Z][A-Za-z0-9_]{2,40}|config|[A-Za-z]*Config)\s*=|["'](?:api ?key|token|secret|client_?id|tenant)[a-z_]*["']\s*[:=]\s*["'][^"']{6,120}["']""",
    "jwt_like": r"""eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-.]{5,}""",
    "blob_urls": r"""blob:https?://[A-Za-z0-9.\-]+/[A-Za-z0-9\-]{8,}""",
    "ws_urls": r"""(?:wss?://[A-Za-z0-9.\-]+(?::\d+)?(?:/[^\s"'<>]*)?)""",
    "env_hints": r"""(?:baseUrl|baseURL|apiUrl|apiBase|homeserver|sentryDsn|identityUrl|issuer|authority)["']?\s*[:=]\s*["'][^"']{4,200}["']""",
}

_NAME_HINTS = (
    "key=secret",
    "token",
    "password",
    "passwd",
    "credential",
    "apikey",
    "api_key",
    "upload",
    "admin",
    "internal",
    "debug",
    "staging",
)


def fetch(url: str, timeout: int = DEFAULT_TIMEOUT) -> str:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": "bountyreaper-js-recon/1.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        data = resp.read(MAX_BYTES)
        return data.decode("utf-8", errors="replace")


def analyze(source: str, name: str) -> dict:
    findings = {}
    for label, pattern in PATTERNS.items():
        hits = sorted({m.group(0).strip("\"' ") if m.lastindex is None or True else m.group(0) for l in [pattern] for m in re.finditer(l, source)})
        # unique + strip trailing quotes without breaking regex-only groups
        uniq = []
        seen = set()
        for h in hits:
            h = h.strip("\"' \r\n,;)")
            if h and h not in seen:
                seen.add(h)
                uniq.append(h)
        if uniq:
            findings[label] = uniq
    # secret-candidate URLs: abs_urls whose path hints at config/admin/etc.
    interesting = [
        u for u in findings.get("abs_urls", [])
        if any(h in u.lower() for h in _NAME_HINTS)
    ]
    if interesting:
        findings["interesting_urls"] = interesting
    return {"source": name, "findings": findings}


def main() -> int:
    argv = sys.argv[1:]
    as_json = "--json-output" in argv
    limit = 200
    skipped = set()
    for i, a in enumerate(argv):
        if a == "--limit" and i + 1 < len(argv):
            try:
                limit = int(argv[i + 1])
                skipped.add(argv[i + 1])  # the numeric value must never parse as a target
            except ValueError:
                pass
    args = [a for a in argv if not a.startswith("--") and a not in skipped]

    if not args:
        print("usage: js_recon <URL_or_local_file...> [--limit N] [--json-output]")
        return 2

    results = []
    for target in args:
        try:
            if target.startswith("http://") or target.startswith("https://"):
                body = fetch(target)
            else:
                with open(target, "r", encoding="utf-8", errors="replace") as fh:
                    body = fh.read(MAX_BYTES)
            results.append(analyze(body, target))
        except Exception as err:  # noqa: BLE001 - report per-source, keep scanning
            results.append({"source": target, "error": str(err)[:200]})

    # trim long lists for readability
    for rr in results:
        f = rr.get("findings") or {}
        for label in list(f):
            if isinstance(f[label], list) and len(f[label]) > limit:
                f[label] = f[label][:limit] + [f"… +{len(f[label]) - limit} more"]

    if as_json:
        print(json.dumps(results, indent=2))
    else:
        for rr in results:
            print(f"== {rr['source']} ==")
            if "error" in rr:
                print(f"   error: {rr['error']}")
                continue
            for label, values in (rr.get("findings") or {}).items():
                print(f"  [{label}] ({len(values)})")
                for v in values[:25]:
                    print(f"    {v}")
                if len(values) > 25:
                    print(f"    … +{len(values) - 25} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
