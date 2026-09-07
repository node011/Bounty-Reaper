"""Phases 11, 12 and 14 — exposed source/config, CORS, GraphQL.

Every check here validates content, not just status. A 200 proves nothing on a
modern stack: SPA catch-all routes, WAF interstitials and custom error pages all
answer 200 with HTML for any path you invent. So each probe establishes a
per-host baseline from a random path first and requires the response to both
differ from that baseline and look like the file it claims to be.

This is the skill's own "kill theoretical findings" rule applied at the point of
detection instead of at triage.
"""

import json
import re
import secrets as _secrets

from . import net

CONFIG_PATHS = (
    "/.env", "/.env.local", "/.env.production", "/.env.backup",
    "/.git/config", "/.git/HEAD", "/.svn/entries", "/.hg/store",
    "/config.json", "/config.yaml", "/config.yml", "/settings.py", "/config.php",
    "/database.yml", "/secrets.yml", "/credentials.json",
    "/wp-config.php.bak", "/web.config", "/.htpasswd", "/.htaccess",
    "/docker-compose.yml", "/Dockerfile", "/.dockerenv",
    "/package.json", "/composer.json", "/composer.lock", "/yarn.lock",
    "/.DS_Store", "/.npmrc", "/.aws/credentials", "/.ssh/id_rsa",
    "/actuator", "/actuator/env", "/actuator/health", "/actuator/heapdump", "/actuator/mappings",
    "/swagger.json", "/swagger-ui.html", "/openapi.json", "/api-docs", "/v2/api-docs",
    "/server-status", "/phpinfo.php", "/info.php", "/debug", "/trace.axd",
    "/backup.sql", "/dump.sql", "/db.sqlite3",
)

GRAPHQL_PATHS = ("/graphql", "/api/graphql", "/v1/graphql", "/query", "/gql", "/graphiql", "/api/gql")

# What each path must actually contain to count. Anything not listed falls back
# to "must not be HTML".
SIGNATURE: dict[str, re.Pattern] = {
    "/.env": re.compile(r"^\s*(?:#|[A-Z][A-Z0-9_]{2,}\s*=)", re.MULTILINE),
    "/.env.local": re.compile(r"^\s*(?:#|[A-Z][A-Z0-9_]{2,}\s*=)", re.MULTILINE),
    "/.env.production": re.compile(r"^\s*(?:#|[A-Z][A-Z0-9_]{2,}\s*=)", re.MULTILINE),
    "/.env.backup": re.compile(r"^\s*(?:#|[A-Z][A-Z0-9_]{2,}\s*=)", re.MULTILINE),
    "/.git/config": re.compile(r"\[core\]|\[remote |repositoryformatversion"),
    "/.git/HEAD": re.compile(r"^ref:\s+refs/"),
    "/.htpasswd": re.compile(r"^[^:\s]+:[^\s]+$", re.MULTILINE),
    "/.DS_Store": re.compile(r"^\x00\x00\x00\x01Bud1"),
    "/package.json": re.compile(r'"(?:name|dependencies|version)"\s*:'),
    "/composer.json": re.compile(r'"(?:require|name|autoload)"\s*:'),
    "/docker-compose.yml": re.compile(r"^\s*(?:services|version)\s*:", re.MULTILINE),
    "/Dockerfile": re.compile(r"^\s*(?:FROM|RUN|COPY|ENTRYPOINT)\s", re.MULTILINE),
    "/actuator": re.compile(r'"_links"|"self"'),
    "/actuator/env": re.compile(r'"propertySources"|"activeProfiles"'),
    "/actuator/heapdump": re.compile(r"^\x1f\x8b|JAVA PROFILE"),
    "/swagger.json": re.compile(r'"(?:swagger|openapi)"\s*:'),
    "/openapi.json": re.compile(r'"(?:swagger|openapi)"\s*:'),
    "/phpinfo.php": re.compile(r"phpinfo\(\)|PHP Version", re.IGNORECASE),
    "/info.php": re.compile(r"phpinfo\(\)|PHP Version", re.IGNORECASE),
    "/server-status": re.compile(r"Apache Server Status|Server uptime"),
}

HTMLISH = re.compile(rb"^\s*(?:<!doctype html|<html|<\?xml.{0,80}<html)", re.IGNORECASE)

SEVERITY = {
    "/.git/config": "high", "/.git/HEAD": "high", "/.env": "critical",
    "/.env.local": "critical", "/.env.production": "critical", "/.env.backup": "critical",
    "/.aws/credentials": "critical", "/.ssh/id_rsa": "critical", "/.npmrc": "high",
    "/actuator/env": "high", "/actuator/heapdump": "critical", "/.htpasswd": "high",
    "/database.yml": "critical", "/secrets.yml": "critical", "/credentials.json": "critical",
    "/backup.sql": "critical", "/dump.sql": "critical", "/db.sqlite3": "critical",
    "/wp-config.php.bak": "critical", "/phpinfo.php": "medium", "/info.php": "medium",
}


async def baseline(origin: str) -> tuple[int | None, int]:
    """Fingerprint how a host answers a path that cannot exist."""
    r = await net.get(f"{origin}/{_secrets.token_hex(12)}")
    if not r:
        return None, 0
    return r.status_code, len(r.content)


async def config_scan(origin: str) -> list[dict]:
    base_status, base_len = await baseline(origin)

    async def one(path: str):
        r = await net.get(origin + path)
        if not r or r.status_code != 200:
            return None
        body = r.content
        # Same shape as the random-path response: it's the catch-all, not a file.
        if r.status_code == base_status and abs(len(body) - base_len) < 32:
            return None

        sig = SIGNATURE.get(path)
        if sig:
            probe = body[:8192] if isinstance(sig.pattern, bytes) else body[:8192].decode("utf-8", "replace")
            if not sig.search(probe):
                return None
        elif HTMLISH.match(body[:200]):
            return None

        return {
            "url": origin + path,
            "path": path,
            "severity": SEVERITY.get(path, "medium"),
            "status": r.status_code,
            "length": len(body),
            "content_type": r.headers.get("content-type", ""),
            "preview": body[:200].decode("utf-8", "replace").replace("\n", " ")[:160],
            "poc": f"curl -sk '{origin}{path}' | head -c 500",
        }

    found = await net.gather([one(p) for p in CONFIG_PATHS])
    rank = {"critical": 0, "high": 1, "medium": 2}
    return sorted(found, key=lambda f: (rank.get(f["severity"], 3), f["path"]))


async def cors_check(origin: str, path: str = "/") -> dict | None:
    """Reflected-origin CORS.

    Only reportable with Access-Control-Allow-Credentials: true — without it the
    attacker page reads exactly what an unauthenticated curl already reads, which
    is not a vulnerability. Mirrors the skill's own kill rule.
    """
    evil = "https://evil-" + _secrets.token_hex(4) + ".com"
    findings = []

    for label, test_origin in (("reflected", evil), ("null", "null")):
        r = await net.get(origin + path, headers={"Origin": test_origin})
        if not r:
            continue
        acao = r.headers.get("access-control-allow-origin", "")
        acac = r.headers.get("access-control-allow-credentials", "").lower() == "true"
        if acao.lower() != test_origin.lower():
            continue
        findings.append({
            "kind": label,
            "origin_sent": test_origin,
            "acao": acao,
            "credentials": acac,
            "severity": "high" if acac else "info",
            "note": "exploitable — reflects arbitrary origin with credentials"
            if acac else
            "not exploitable on its own: no Access-Control-Allow-Credentials, so an attacker page "
            "reads only what an unauthenticated request already returns",
            "poc": f"curl -sk -H 'Origin: {test_origin}' -I '{origin}{path}' | grep -i access-control",
        })

    if not findings:
        return None
    return {"url": origin + path, "findings": findings,
            "severity": "high" if any(f["credentials"] for f in findings) else "info"}


async def graphql_discover(origin: str) -> list[dict]:
    async def one(path: str):
        url = origin + path
        r = await net.get(url, method="POST", json={"query": "{__typename}"},
                          headers={"Content-Type": "application/json"})
        if not r or r.status_code not in (200, 400):
            return None
        try:
            data = r.json()
        except (json.JSONDecodeError, ValueError):
            return None
        # A GraphQL endpoint answers with data or a GraphQL-shaped error; a
        # generic JSON 404 handler does neither.
        if "data" not in data and "errors" not in data:
            return None

        intro = await net.get(
            url, method="POST",
            json={"query": "{__schema{queryType{name} types{name}}}"},
            headers={"Content-Type": "application/json"},
        )
        types, introspection = [], False
        if intro:
            try:
                schema = intro.json().get("data", {}).get("__schema")
                if schema:
                    introspection = True
                    types = [t["name"] for t in schema.get("types", []) if not t["name"].startswith("__")][:60]
            except (json.JSONDecodeError, ValueError, AttributeError):
                pass

        return {
            "url": url,
            "introspection_enabled": introspection,
            "severity": "medium" if introspection else "info",
            "type_sample": types,
            "type_count": len(types),
            "poc": f"""curl -s -X POST '{url}' -H 'Content-Type: application/json' """
                   f"""-d '{{"query":"{{__schema{{types{{name}}}}}}"}}' | jq '.data.__schema.types[].name'""",
        }

    return await net.gather([one(p) for p in GRAPHQL_PATHS])
