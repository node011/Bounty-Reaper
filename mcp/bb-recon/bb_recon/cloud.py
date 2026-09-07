"""Phase 10 — cloud storage enumeration.

Distinguishes the three states that matter, because only one of them is a bug:

  missing    the name is unregistered — no finding (and a takeover candidate at
             most, since anyone could claim it)
  private    the bucket exists but denies listing — no finding on its own; the
             skill's kill rule drops these
  public     the bucket exists and lists its contents to an anonymous caller

Requests go to AWS/GCS/Azure, not to the target, but the *names* are derived
from the engagement, so the apex is scope-checked before any guessing starts.
"""

import re

from . import net

AFFIXES = (
    "", "-dev", "-development", "-staging", "-stage", "-prod", "-production", "-test", "-qa", "-uat",
    "-backup", "-backups", "-bak", "-archive", "-assets", "-static", "-media", "-images", "-img",
    "-uploads", "-files", "-data", "-db", "-dump", "-logs", "-cdn", "-public", "-private",
    "-internal", "-secret", "-config", "-terraform", "-tf-state", "-artifacts", "-build",
)

BUCKET_OK = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


def candidates(domain: str, extra: list[str] | None = None) -> list[str]:
    """Name guesses derived from the target, in the shapes teams actually use."""
    apex = domain.split(".")[0]
    stems = {domain, domain.replace(".", "-"), domain.replace(".", ""), apex}
    stems.update(extra or [])

    out = set()
    for stem in stems:
        stem = stem.strip().lower()
        if not stem:
            continue
        for affix in AFFIXES:
            name = stem + affix
            if BUCKET_OK.match(name):
                out.add(name)
            # teams write both orders: "dev-acme" as often as "acme-dev"
            if affix:
                name = affix.lstrip("-") + "-" + stem
                if BUCKET_OK.match(name):
                    out.add(name)
    return sorted(out)


async def _s3(name: str) -> dict | None:
    r = await net.get(f"https://{name}.s3.amazonaws.com/?list-type=2&max-keys=10")
    if not r:
        return None
    body = r.text[:4000]
    if "NoSuchBucket" in body:
        return {"name": name, "provider": "s3", "state": "missing", "severity": "info",
                "note": "unregistered — claimable by anyone, check whether anything still points at it"}
    if r.status_code == 200 and "<ListBucketResult" in body:
        keys = re.findall(r"<Key>([^<]+)</Key>", body)
        return {
            "name": name, "provider": "s3", "state": "public", "severity": "high",
            "keys_sample": keys[:10], "note": "anonymous listing succeeded",
            "poc": f"curl -s 'https://{name}.s3.amazonaws.com/?list-type=2&max-keys=10'",
        }
    if "AccessDenied" in body or r.status_code == 403:
        return {"name": name, "provider": "s3", "state": "private", "severity": "info",
                "note": "exists but denies anonymous listing — not a finding by itself"}
    return None


async def _gcs(name: str) -> dict | None:
    r = await net.get(f"https://storage.googleapis.com/storage/v1/b/{name}/o?maxResults=10")
    if not r:
        return None
    if r.status_code == 200:
        try:
            items = [i["name"] for i in r.json().get("items", [])][:10]
        except (ValueError, KeyError, TypeError):
            items = []
        return {"name": name, "provider": "gcs", "state": "public", "severity": "high",
                "keys_sample": items, "note": "anonymous listing succeeded",
                "poc": f"curl -s 'https://storage.googleapis.com/storage/v1/b/{name}/o?maxResults=10'"}
    if r.status_code in (401, 403):
        return {"name": name, "provider": "gcs", "state": "private", "severity": "info",
                "note": "exists but denies anonymous listing"}
    return None


async def _azure(name: str) -> dict | None:
    r = await net.get(f"https://{name}.blob.core.windows.net/?comp=list")
    if not r:
        return None
    body = r.text[:4000]
    if r.status_code == 200 and "<Containers>" in body:
        containers = re.findall(r"<Name>([^<]+)</Name>", body)
        return {"name": name, "provider": "azure", "state": "public", "severity": "high",
                "keys_sample": containers[:10], "note": "anonymous container listing succeeded",
                "poc": f"curl -s 'https://{name}.blob.core.windows.net/?comp=list'"}
    if r.status_code in (403, 409):
        return {"name": name, "provider": "azure", "state": "private", "severity": "info",
                "note": "storage account exists but denies anonymous listing"}
    return None


async def _firebase(name: str) -> dict | None:
    for host in (f"https://{name}.firebaseio.com", f"https://{name}-default-rtdb.firebaseio.com"):
        r = await net.get(f"{host}/.json?shallow=true")
        if not r or r.status_code != 200:
            continue
        try:
            data = r.json()
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and "error" not in data and data:
            return {"name": name, "provider": "firebase", "state": "public", "severity": "critical",
                    "keys_sample": sorted(data)[:10], "note": "database readable without authentication",
                    "poc": f"curl -s '{host}/.json?shallow=true'"}
    return None


async def enumerate_buckets(domain: str, extra: list[str] | None = None, limit: int = 200) -> dict:
    names = candidates(domain, extra)[:limit]
    coros = []
    for n in names:
        coros += [_s3(n), _gcs(n), _azure(n), _firebase(n)]

    results = await net.gather(coros)
    rank = {"critical": 0, "high": 1, "info": 2}
    results.sort(key=lambda r: (rank.get(r["severity"], 3), r["provider"], r["name"]))

    exposed = [r for r in results if r["state"] == "public"]
    return {
        "domain": domain,
        "names_tried": len(names),
        "requests": len(coros),
        "exposed": exposed,
        "exposed_count": len(exposed),
        "other": [r for r in results if r["state"] != "public"],
        "note": "Only `exposed` entries are findings. `private` means the bucket exists but denies "
                "listing, which the triage rules discard; `missing` names are unclaimed.",
    }
