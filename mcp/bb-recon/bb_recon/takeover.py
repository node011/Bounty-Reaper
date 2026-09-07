"""Phase 4 — subdomain takeover.

Detection requires two independent signals that agree:

  1. the host CNAMEs onto a known third-party service, and
  2. that service returns its specific "unclaimed" fingerprint.

Fingerprint alone is how every takeover scanner earns its false-positive
reputation — a bare "404 Not Found" body matches half the internet and means
nothing without the delegation to back it. Confidence is reported explicitly so
the caller can tell an actionable finding from a lead.
"""

import asyncio
import shutil

from . import net

# service -> (CNAME suffixes that delegate to it, body fingerprints when unclaimed)
SERVICES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "github-pages": (
        ("github.io", "githubusercontent.com"),
        ("There isn't a GitHub Pages site here", "For root URLs (like http://example.com/) you must provide an index.html file"),
    ),
    "aws-s3": (
        ("s3.amazonaws.com", "s3-website", ".s3."),
        ("NoSuchBucket", "The specified bucket does not exist"),
    ),
    "heroku": (
        ("herokuapp.com", "herokudns.com", "herokussl.com"),
        ("No such app", "herokucdn.com/error-pages/no-such-app.html"),
    ),
    "netlify": (
        ("netlify.app", "netlify.com"),
        ("Not Found - Request ID", "a Netlify site"),
    ),
    "vercel": (
        ("vercel.app", "vercel-dns.com", "now.sh"),
        ("The deployment could not be found on Vercel", "DEPLOYMENT_NOT_FOUND"),
    ),
    "shopify": (
        ("myshopify.com",),
        ("Sorry, this shop is currently unavailable", "Only one step left!"),
    ),
    "fastly": (
        ("fastly.net", "fastlylb.net"),
        ("Fastly error: unknown domain",),
    ),
    "pantheon": (("pantheonsite.io",), ("The gods are wise, but do not know of the site which you seek",)),
    "tumblr": (("domains.tumblr.com",), ("Whatever you were looking for doesn't currently exist at this address",)),
    "wordpress": (("wordpress.com",), ("Do you want to register",)),
    "bitbucket": (("bitbucket.io",), ("Repository not found",)),
    "gitlab-pages": (("gitlab.io",), ("The page you're looking for could not be found",)),
    "surge": (("surge.sh",), ("project not found",)),
    "helpscout": (("helpscoutdocs.com",), ("No settings were found for this company",)),
    "cargo": (("cargocollective.com",), ("404 Not Found<",)),
    "webflow": (("proxy-ssl.webflow.com", "webflow.io"), ("The page you are looking for doesn't exist or has been moved",)),
    "readthedocs": (("readthedocs.io",), ("unknown to Read the Docs",)),
    "azure": (
        ("azurewebsites.net", "cloudapp.azure.com", "trafficmanager.net", "blob.core.windows.net"),
        ("404 Web Site not found", "The specified container does not exist"),
    ),
    "zendesk": (("zendesk.com",), ("Help Center Closed",)),
    "statuspage": (("statuspage.io",), ("You are being <a href=\"https://www.statuspage.io",)),
    "ghost": (("ghost.io",), ("The thing you were looking for is no longer here",)),
    "desk": (("desk.com",), ("Sorry, We Couldn't Find That Page",)),
    "cloudfront": (("cloudfront.net",), ("ERROR: The request could not be satisfied",)),
}


async def cname(host: str) -> list[str]:
    """CNAME chain via dig, else empty. Absence downgrades confidence, never invents one."""
    if not shutil.which("dig"):
        return []
    proc = await asyncio.create_subprocess_exec(
        "dig", "+short", "CNAME", host,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
    except (TimeoutError, asyncio.TimeoutError):
        proc.kill()
        return []
    return [line.strip().rstrip(".").lower() for line in out.decode().splitlines() if line.strip()]


def _delegated(chain: list[str]) -> list[str]:
    return [name for name, (suffixes, _) in SERVICES.items() if any(s in c for c in chain for s in suffixes)]


def _fingerprinted(body: str) -> list[str]:
    return [name for name, (_, prints) in SERVICES.items() if any(p.lower() in body for p in prints)]


async def _one(host: str) -> dict | None:
    chain = await cname(host)
    delegated = _delegated(chain)

    body = ""
    status = None
    for url in net.urls([host]):
        r = await net.get(url)
        if r is not None:
            body = r.text[:20000].lower()
            status = r.status_code
            break

    fingerprinted = _fingerprinted(body) if body else []
    if not delegated and not fingerprinted:
        return None

    both = sorted(set(delegated) & set(fingerprinted))
    if both:
        confidence, service, reason = "high", both[0], "CNAME delegation and unclaimed-service fingerprint agree"
    elif delegated and not body:
        confidence, service, reason = (
            "low",
            delegated[0],
            "CNAME points at a third-party service but the host did not respond — verify manually",
        )
    elif delegated:
        confidence, service, reason = (
            "low",
            delegated[0],
            "CNAME points at a third-party service but no unclaimed fingerprint — likely a live, claimed site",
        )
    else:
        confidence, service, reason = (
            "medium",
            fingerprinted[0],
            "unclaimed-service fingerprint without a matching CNAME (dig missing, or the record is an ALIAS/A)",
        )

    return {
        "host": host,
        "service": service,
        "confidence": confidence,
        "reason": reason,
        "cname_chain": chain,
        "status": status,
        "poc": f"curl -sk https://{host}/ | head -40",
    }


async def scan(hosts: list[str]) -> list[dict]:
    found = await net.gather([_one(h) for h in hosts])
    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(found, key=lambda f: (order[f["confidence"]], f["host"]))
