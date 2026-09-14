"""Engagement scope — the gate every active tool passes through.

Passive tools (crt.sh, wayback) touch third-party archives, not the target, so
they run unscoped. Everything that sends a packet to the target calls require()
first and raises ScopeError when the host is not authorised.

Scope lives on disk, not in tool arguments. A model can ask to test a host; it
cannot widen what "in scope" means — that is a decision the operator writes to
scope.json once, and every subsequent call is measured against it.
"""

import ipaddress
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

# Ranges an internet-facing engagement must never touch: loopback, link-local,
# RFC1918, CGNAT, and the cloud metadata endpoints. Reachable from the scanning
# host, never in scope for an external test, and 169.254.169.254 in particular
# turns a recon tool into an SSRF exploit against its own operator.
PRIVATE = [
    ipaddress.ip_network(n)
    for n in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "100.64.0.0/10",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
]

IPV4 = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


class ScopeError(Exception):
    """Raised when a target is not in the engagement scope."""


def root() -> Path:
    base = Path(os.environ.get("BB_RECON_OUTPUT_DIR", str(Path.cwd() / ".bountyreaper" / "recon")))
    base.mkdir(parents=True, exist_ok=True)
    return base


def path() -> Path:
    return root() / "scope.json"


def host(target: str) -> str:
    """Reduce a URL, host:port or bare host to a comparable hostname."""
    t = target.strip().lower()
    if "://" in t:
        t = urlsplit(t).netloc or t
    t = t.split("@")[-1]
    if t.startswith("["):  # bracketed IPv6, optionally with :port
        return t.partition("]")[0].lstrip("[")
    # A bare IPv6 address has several colons; host:port has exactly one. Without
    # this, "::1" splits to "" and every reserved-range check silently passes.
    if t.count(":") > 1:
        return t
    return t.split(":")[0].rstrip(".")


def load() -> dict:
    """Scope from disk, else BB_RECON_SCOPE, else empty (deny-all)."""
    p = path()
    if p.exists():
        return json.loads(p.read_text())
    env = os.environ.get("BB_RECON_SCOPE", "").strip()
    if env:
        return {
            "include": [s.strip() for s in env.split(",") if s.strip()],
            "exclude": [],
            "allow_private": os.environ.get("BB_RECON_ALLOW_PRIVATE") == "1",
            "source": "BB_RECON_SCOPE",
        }
    return {"include": [], "exclude": [], "allow_private": False, "source": "unset"}


def save(include: list[str], exclude: list[str] | None = None, allow_private: bool = False) -> dict:
    scope = {
        "include": sorted({s.strip().lower() for s in include if s.strip()}),
        "exclude": sorted({s.strip().lower() for s in (exclude or []) if s.strip()}),
        "allow_private": allow_private,
        "source": str(path()),
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    path().write_text(json.dumps(scope, indent=2))
    return scope


def _ip(target: str):
    try:
        return ipaddress.ip_address(target)
    except ValueError:
        return None


def _matches(target: str, rule: str) -> tuple[bool, str]:
    if target == rule:
        return True, "exact match"

    if rule.startswith("*."):
        apex = rule[2:]
        if target == apex:
            return True, f"apex of wildcard {rule}"
        if target.endswith("." + apex):
            return True, f"subdomain of wildcard {rule}"
        return False, ""

    if "/" in rule:
        try:
            net = ipaddress.ip_network(rule, strict=False)
        except ValueError:
            return False, ""
        ip = _ip(target)
        if ip and ip in net:
            return True, f"inside CIDR {rule}"
        return False, ""

    return False, ""


def check(target: str, scope: dict | None = None) -> dict:
    """Decide a single target. Never raises — use for reporting."""
    scope = scope or load()
    h = host(target)
    if not h:
        return {"target": target, "host": h, "in_scope": False, "reason": "empty host"}

    ip = _ip(h)
    if ip and not scope.get("allow_private"):
        for net in PRIVATE:
            if ip.version == net.version and ip in net:
                return {
                    "target": target,
                    "host": h,
                    "in_scope": False,
                    "reason": f"{h} is in reserved range {net} (set allow_private for internal engagements)",
                }

    for rule in scope.get("exclude", []):
        ok, why = _matches(h, rule)
        if ok:
            return {"target": target, "host": h, "in_scope": False, "reason": f"excluded: {why}"}

    for rule in scope.get("include", []):
        ok, why = _matches(h, rule)
        if ok:
            return {"target": target, "host": h, "in_scope": True, "reason": why}

    if not scope.get("include"):
        return {
            "target": target,
            "host": h,
            "in_scope": False,
            "reason": "no scope configured — call scope_set first (deny-by-default)",
        }
    return {"target": target, "host": h, "in_scope": False, "reason": "no matching in-scope rule"}


def require(targets: list[str] | str, scope: dict | None = None) -> list[str]:
    """Gate an active operation. Returns in-scope hosts, raises if none survive.

    A partial list is allowed through — out-of-scope entries are dropped rather
    than failing the whole batch, because a subdomain sweep legitimately turns up
    third-party hosts. An empty result is an error: it means the caller asked for
    nothing it was allowed to touch.
    """
    scope = scope or load()
    items = [targets] if isinstance(targets, str) else targets
    allowed, denied = [], []
    for t in items:
        verdict = check(t, scope)
        (allowed if verdict["in_scope"] else denied).append(verdict)

    if not allowed:
        reasons = "; ".join(f"{d['host']}: {d['reason']}" for d in denied[:5])
        raise ScopeError(
            f"No in-scope targets. {len(denied)} rejected. {reasons}"
            + ("" if len(denied) <= 5 else f" (+{len(denied) - 5} more)")
        )
    return [a["target"] for a in allowed]


def audit(action: str, targets: list[str], detail: dict | None = None) -> None:
    """Append-only record of every active operation.

    Written before the packets go out, so a crashed or killed scan still leaves
    evidence of what it was about to do.
    """
    line = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "action": action,
        "count": len(targets),
        "targets": targets[:50],
        **(detail or {}),
    }
    with (root() / "audit.jsonl").open("a") as f:
        f.write(json.dumps(line) + "\n")
