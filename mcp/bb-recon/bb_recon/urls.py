"""Phases 5 and 13 — historical URL collection, juicy-file triage, injection candidates.

Sources are public archives (Wayback, AlienVault OTX, URLScan), so harvesting is
passive: it touches the archives, never the target. Only the optional liveness
probe reaches the target, and that one is scope-gated by the caller.

The skill's shell version shells out to waybackurls/gau/waymore. This does the
same queries over plain HTTP so the tool works on a fresh clone with no Go
toolchain — the portability rule for everything bundled in this repo.
"""

import asyncio
import json
import re
from urllib.parse import parse_qs, urlsplit

from . import net, scope

JUICY = re.compile(
    r"\.(bak|backup|sql|db|sqlite3?|json|xml|ya?ml|env|config|conf|log|old|orig|save|swp|gz|tgz|zip|tar|7z|rar"
    r"|xls|xlsx|doc|docx|csv|pem|key|crt|p12|pfx|jks|ppk|dump|sav)(\?|$)",
    re.IGNORECASE,
)

# Extensions that match JUICY but are almost always public content, not leakage.
BORING = re.compile(r"\.(json|xml)(\?|$)", re.IGNORECASE)

SENSITIVE_PATH = re.compile(
    r"(admin|panel|dashboard|manage|console|config|debug|internal|staging|backup|graphql|swagger"
    r"|openapi|api-docs|actuator|metrics|health|phpinfo|\.git|\.env|wp-admin)",
    re.IGNORECASE,
)

# Parameter names that carry a URL or a path the server will act on.
SSRF_PARAM = re.compile(
    r"^(url|uri|u|link|href|endpoint|host|hostname|server|proxy|dest|destination|redirect|redirect_uri|redir"
    r"|target|to|next|return|return_url|returnto|continue|src|source|feed|rss|webhook|callback|cb|ref"
    r"|referrer|path|file|filename|load|fetch|pull|remote|request|domain|site|page|data|image|img|resource)$",
    re.IGNORECASE,
)

# Values that look like a full URL or an absolute path, regardless of param name.
URLISH = re.compile(r"^(https?://|//|/[a-z0-9_\-./]+$)", re.IGNORECASE)


async def wayback(domain: str) -> set[str]:
    r = await net.get(
        "https://web.archive.org/cdx/search/cdx",
        params={"url": f"*.{domain}/*", "fl": "original", "collapse": "urlkey", "limit": "20000"},
    )
    if not r or r.status_code != 200:
        return set()
    # The Internet Archive serves its "Temporarily Offline" page as 200 text/html.
    # Status alone is not proof of a CDX response, so require the shape too:
    # every real line is a bare URL.
    if "html" in r.headers.get("content-type", "").lower():
        return set()
    return {line.strip() for line in r.text.splitlines() if line.strip().startswith("http")}


async def otx(domain: str) -> set[str]:
    out: set[str] = set()
    for page in range(1, 4):
        r = await net.get(f"https://otx.alienvault.com/api/v1/indicators/domain/{domain}/url_list",
                          params={"limit": "500", "page": str(page)})
        if not r or r.status_code != 200:
            break
        try:
            rows = r.json().get("url_list", [])
        except (json.JSONDecodeError, ValueError):
            break
        if not rows:
            break
        out.update(row["url"] for row in rows if row.get("url"))
    return out


async def urlscan(domain: str) -> set[str]:
    r = await net.get("https://urlscan.io/api/v1/search/", params={"q": f"domain:{domain}", "size": "1000"})
    if not r or r.status_code != 200:
        return set()
    try:
        return {row["page"]["url"] for row in r.json().get("results", []) if row.get("page", {}).get("url")}
    except (json.JSONDecodeError, ValueError, KeyError):
        return set()


async def harvest(domain: str) -> dict:
    names = ("wayback", "otx", "urlscan")
    # Positional, not net.gather(): that one *drops* failures, which shifts the
    # list and silently attributes one source's URLs to another's name.
    results = await asyncio.gather(
        wayback(domain), otx(domain), urlscan(domain), return_exceptions=True
    )

    by_source: dict[str, int] = {}
    errors: dict[str, str] = {}
    merged: set[str] = set()
    for name, result in zip(names, results):
        if isinstance(result, BaseException):
            errors[name] = f"{type(result).__name__}: {result}"
            by_source[name] = 0
            continue
        by_source[name] = len(result)
        merged.update(result)

    keep = {u for u in merged if _in_domain(u, domain)}
    return {
        "merged": sorted(keep),
        "by_source": by_source,
        "errors": errors,
        "dropped_offdomain": len(merged) - len(keep),
    }


def _in_domain(url: str, domain: str) -> bool:
    h = scope.host(url)
    return h == domain or h.endswith("." + domain)


def classify(urls: list[str]) -> dict:
    """Split a URL corpus into the buckets a hunter actually works from."""
    juicy, sensitive, params, ssrf = [], [], [], []
    seen_shapes: set[tuple[str, str, tuple[str, ...]]] = set()

    for u in urls:
        if JUICY.search(u) and not BORING.search(u):
            juicy.append(u)
        if SENSITIVE_PATH.search(urlsplit(u).path):
            sensitive.append(u)

        q = urlsplit(u).query
        if not q:
            continue

        parsed = parse_qs(q, keep_blank_values=True)
        if not parsed:
            continue

        # One representative per (host, path, param-set): a corpus with 4000
        # ?id=N URLs is one endpoint, and reporting it 4000 times buries the
        # endpoints that only appear once.
        s = urlsplit(u)
        shape = (s.netloc, s.path, tuple(sorted(parsed)))
        if shape in seen_shapes:
            continue
        seen_shapes.add(shape)
        params.append(u)

        hits = [
            k for k, vals in parsed.items()
            if SSRF_PARAM.match(k) or any(URLISH.match(v) for v in vals if v)
        ]
        if hits:
            ssrf.append({"url": u, "params": sorted(hits)})

    return {
        "juicy_files": sorted(set(juicy)),
        "sensitive_paths": sorted(set(sensitive)),
        "parameterized": sorted(params),
        "ssrf_candidates": ssrf,
    }


async def probe_juicy(urls: list[str], limit: int = 100) -> list[dict]:
    """Which archived juicy files are still served? Active — gate before calling."""

    async def one(u: str):
        r = await net.get(u)
        if not r or r.status_code != 200:
            return None
        body = r.content[:2048]
        # An HTML error page served with 200 is the usual outcome; a real backup
        # file is not HTML.
        if body.lstrip()[:15].lower().startswith((b"<!doctype html", b"<html")):
            return None
        return {
            "url": u,
            "status": r.status_code,
            "content_type": r.headers.get("content-type", ""),
            "length": int(r.headers.get("content-length") or len(r.content)),
            "poc": f"curl -sk '{u}' | head -c 500",
        }

    return await net.gather([one(u) for u in urls[:limit]])
