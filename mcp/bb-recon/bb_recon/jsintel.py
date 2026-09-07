"""Phase 8 — JavaScript analysis: secrets, endpoints, SSR state blobs.

Detection only. This module never authenticates with a credential it finds.

The skill's shell version pipes every discovered key straight into
api.openai.com / sts.amazonaws.com / api.github.com to prove liveness. That step
authenticates as the victim against a third party, from the operator's IP, and
is logged on an account nobody in the engagement controls — it is a decision for
a human with the scope document in hand, not something a recon sweep should do
on its own. So each finding ships with the exact validation command instead, and
the operator runs it.
"""

import math
import re
from collections import Counter

from . import net

SCRIPT_SRC = re.compile(r"""<script[^>]+src=["']([^"']+)["']""", re.IGNORECASE)
INLINE_URL = re.compile(r"""["'`](https?://[^\s"'`]+?\.js(?:\?[^\s"'`]*)?)["'`]""")

# name -> (pattern, severity, how to prove it live — run by a human, not by us)
SECRETS: dict[str, tuple[re.Pattern, str, str]] = {
    "aws_access_key": (
        re.compile(r"\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b"),
        "critical",
        "aws sts get-caller-identity  # with the matching secret key",
    ),
    "openai_key": (re.compile(r"\b(sk-(?:proj-)?[A-Za-z0-9_-]{40,})\b"), "critical",
                   "curl -s https://api.openai.com/v1/models -H 'Authorization: Bearer KEY'"),
    "anthropic_key": (re.compile(r"\b(sk-ant-[A-Za-z0-9_-]{90,})\b"), "critical",
                      "curl -s https://api.anthropic.com/v1/models -H 'x-api-key: KEY' -H 'anthropic-version: 2023-06-01'"),
    "github_pat": (re.compile(r"\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{36,})\b"), "critical",
                   "curl -s https://api.github.com/user -H 'Authorization: token KEY'"),
    "slack_token": (re.compile(r"\b(xox[baprs]-[0-9A-Za-z-]{10,})\b"), "critical",
                    "curl -s https://slack.com/api/auth.test -H 'Authorization: Bearer KEY'"),
    "stripe_live": (re.compile(r"\b((?:sk|rk)_live_[0-9A-Za-z]{24,})\b"), "critical",
                    "curl -s https://api.stripe.com/v1/account -u 'KEY:'"),
    "google_api_key": (re.compile(r"\b(AIza[0-9A-Za-z_-]{35})\b"), "high",
                       "curl -s 'https://maps.googleapis.com/maps/api/geocode/json?address=x&key=KEY'"),
    "private_key": (re.compile(r"(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)"), "critical",
                    "inspect the key material directly"),
    "jwt": (re.compile(r"\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b"), "medium",
            "decode the payload; check exp and whether it is a live session token"),
    "slack_webhook": (re.compile(r"(https://hooks\.slack\.com/services/T[A-Za-z0-9_/]{20,})"), "high",
                      "POST a benign message to confirm delivery"),
    "firebase_db": (re.compile(r"(https://[a-z0-9-]+\.firebaseio\.com)"), "medium",
                    "curl -s 'URL/.json?shallow=true'"),
    "mongodb_uri": (re.compile(r"(mongodb(?:\+srv)?://[^\s\"'<>]{10,})"), "critical",
                    "inspect credentials embedded in the URI"),
    "postgres_uri": (re.compile(r"(postgres(?:ql)?://[^\s\"'<>]{10,})"), "critical",
                     "inspect credentials embedded in the URI"),
    "sendgrid_key": (re.compile(r"\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b"), "critical",
                     "curl -s https://api.sendgrid.com/v3/scopes -H 'Authorization: Bearer KEY'"),
    "twilio_sid": (re.compile(r"\b(AC[0-9a-fA-F]{32})\b"), "high",
                   "curl -s https://api.twilio.com/2010-04-01/Accounts/SID.json -u 'SID:TOKEN'"),
    "npm_token": (re.compile(r"\b(npm_[A-Za-z0-9]{36})\b"), "high",
                  "curl -s https://registry.npmjs.org/-/whoami -H 'Authorization: Bearer KEY'"),
    "hf_token": (re.compile(r"\b(hf_[A-Za-z0-9]{34})\b"), "high",
                 "curl -s https://huggingface.co/api/whoami-v2 -H 'Authorization: Bearer KEY'"),
}

ENDPOINT = re.compile(r"""["'`](/(?:api|v\d|graphql|rest|internal|admin|auth|oauth)/[A-Za-z0-9/_.:{}-]{2,80})["'`]""")
SSR_STATE = re.compile(r"(window\.__(?:NEXT_DATA__|NUXT__|INITIAL_STATE__|APOLLO_STATE__|PRELOADED_STATE__))")

# Substrings that mean the "secret" came from a doc, a test fixture or a
# minified placeholder rather than a real deployment.
PLACEHOLDER = re.compile(
    r"(example|sample|dummy|placeholder|your[_-]?key|xxx+|000000|123456|redacted|<[a-z_]+>|changeme|test[_-]?key)",
    re.IGNORECASE,
)


def entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def mask(m: str) -> str:
    """Never emit a full credential.

    Findings travel through model context, logs and reports. Enough to
    recognise and grep for the value, never enough to use it. An AWS key is
    exactly 20 characters, so any threshold above that silently passes the
    highest-severity type straight through in the clear.
    """
    if len(m) <= 8:
        return (m[0] + "…") if m else ""
    return f"{m[:4]}…{m[-4:]}"


def _context(body: str, match: str, width: int = 60) -> str:
    """Surrounding source, with the secret itself redacted out of it."""
    i = body.find(match)
    if i < 0:
        return ""
    window = body[max(0, i - width): i + len(match) + width]
    return " ".join(window.replace(match, mask(match)).split())


def scan_text(body: str, source: str) -> list[dict]:
    out = []
    for name, (pattern, severity, validate) in SECRETS.items():
        for m in set(pattern.findall(body)):
            if PLACEHOLDER.search(m):
                continue
            # High-entropy check applies only to opaque-blob types; structured
            # values (URIs, PEM headers) are legitimately low-entropy.
            if name not in ("private_key", "mongodb_uri", "postgres_uri", "firebase_db", "slack_webhook"):
                if entropy(m) < 3.0:
                    continue
            out.append({
                "type": name,
                "severity": severity,
                "match": mask(m),
                "full_length": len(m),
                "source": source,
                "context": _context(body, m),
                "validate": validate,
            })
    return out


async def discover(url: str) -> dict:
    """Find the JS a page loads, plus the SSR state blobs it inlines."""
    r = await net.get(url)
    if not r:
        return {"url": url, "scripts": [], "ssr_state": [], "error": "no response"}
    body = r.text
    base = url.rstrip("/")
    origin = "/".join(base.split("/")[:3])

    scripts = set()
    for src in SCRIPT_SRC.findall(body) + INLINE_URL.findall(body):
        if src.startswith("//"):
            scripts.add("https:" + src)
        elif src.startswith("http"):
            scripts.add(src)
        elif src.startswith("/"):
            scripts.add(origin + src)
        else:
            scripts.add(base + "/" + src)

    return {
        "url": url,
        "scripts": sorted(s for s in scripts if ".js" in s),
        "ssr_state": sorted(set(SSR_STATE.findall(body))),
        "inline_secrets": scan_text(body, url),
    }


async def analyze(js_urls: list[str], max_bytes: int = 3_000_000) -> dict:
    """Fetch JS bundles and mine them for secrets and endpoints."""
    secrets: list[dict] = []
    endpoints: set[str] = set()
    fetched, skipped = 0, 0

    async def one(u: str):
        nonlocal fetched, skipped
        r = await net.get(u)
        if not r or r.status_code != 200:
            skipped += 1
            return None
        body = r.text[:max_bytes]
        fetched += 1
        return u, body

    for item in await net.gather([one(u) for u in js_urls]):
        u, body = item
        secrets.extend(scan_text(body, u))
        endpoints.update(ENDPOINT.findall(body))

    rank = {"critical": 0, "high": 1, "medium": 2}
    secrets.sort(key=lambda s: (rank.get(s["severity"], 3), s["type"]))
    return {
        "files_fetched": fetched,
        "files_failed": skipped,
        "secrets": secrets,
        "secret_count_by_severity": dict(Counter(s["severity"] for s in secrets)),
        "endpoints": sorted(endpoints),
        "note": "Secrets are detected, never validated. Run each finding's `validate` command yourself "
                "once you have confirmed the key is in engagement scope.",
    }
