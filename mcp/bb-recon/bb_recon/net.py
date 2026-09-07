"""Shared HTTP layer for the active phases.

One place for concurrency, timeouts, retry-free failure handling and the
politeness limits, so no individual phase can decide to hammer a target harder
than the engagement allows.
"""

import asyncio
import os

import httpx

UA = os.environ.get("BB_RECON_UA", "bb-recon/0.2 (BountyReper recon; +https://bountyreper.io)")

# Concurrency is per-process, not per-host. Deliberately modest: recon runs
# against production estates, and a bug bounty program that rate-limits you is a
# program you have stopped testing.
CONCURRENCY = int(os.environ.get("BB_RECON_CONCURRENCY", "20"))
TIMEOUT = float(os.environ.get("BB_RECON_TIMEOUT", "8"))

_sem: asyncio.Semaphore | None = None


def sem() -> asyncio.Semaphore:
    # Built lazily: a Semaphore binds to the running loop, and the module is
    # imported before FastMCP starts one.
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(CONCURRENCY)
    return _sem


def client(**kw) -> httpx.AsyncClient:
    kw.setdefault("timeout", TIMEOUT)
    kw.setdefault("follow_redirects", True)
    kw.setdefault("verify", False)  # recon targets routinely have broken chains
    kw.setdefault("headers", {"User-Agent": UA})
    return httpx.AsyncClient(**kw)


async def get(url: str, *, method: str = "GET", **kw) -> httpx.Response | None:
    """Single request. Returns None on any transport failure — callers treat a
    dead host as absence of evidence, never as a finding."""
    async with sem():
        try:
            async with client() as c:
                return await c.request(method, url, **kw)
        except Exception:
            return None


async def gather(coros: list, limit: int | None = None) -> list:
    """Run coroutines, dropping failures. Keeps one bad host from sinking a sweep."""
    results = await asyncio.gather(*coros, return_exceptions=True)
    return [r for r in results if r is not None and not isinstance(r, Exception)]


def urls(hosts: list[str], scheme: str = "both") -> list[str]:
    out = []
    for h in hosts:
        if "://" in h:
            out.append(h.rstrip("/"))
            continue
        if scheme in ("both", "https"):
            out.append(f"https://{h}")
        if scheme in ("both", "http"):
            out.append(f"http://{h}")
    return out
