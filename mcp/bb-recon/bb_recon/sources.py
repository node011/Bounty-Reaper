import asyncio
import shutil
from urllib.parse import quote

import httpx

UA = "bb-recon/0.1 (BountyReaper bug bounty recon)"


def clean(lines: list[str]) -> set[str]:
    out = set()
    for line in lines:
        s = line.strip().lower()
        s = s.removeprefix("*.").strip()
        if s and "." in s and " " not in s:
            out.add(s)
    return out


async def fetch_crtsh(domain: str) -> set[str]:
    async with httpx.AsyncClient(timeout=40, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get(f"https://crt.sh/?q=%25.{quote(domain)}&output=json")
        r.raise_for_status()
        names: set[str] = set()
        for row in r.json():
            for n in str(row.get("name_value", "")).split("\n"):
                names.add(n.strip())
        return clean(list(names))


async def fetch_agniops(domain: str) -> set[str]:
    async with httpx.AsyncClient(timeout=40, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://app.agniops.in/v1/search", params={"domain": domain})
        r.raise_for_status()
        return clean(r.text.splitlines())


async def fetch_crtname(domain: str) -> set[str]:
    async with httpx.AsyncClient(timeout=40, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://crt.name/v1/search", params={"apex": domain})
        r.raise_for_status()
        return clean(r.text.splitlines())


async def run_subfinder(domain: str) -> set[str]:
    if not shutil.which("subfinder"):
        return set()
    proc = await asyncio.create_subprocess_exec(
        "subfinder",
        "-d",
        domain,
        "-all",
        "-silent",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=180)
    except TimeoutError:
        proc.kill()
        return set()
    return clean(out.decode().splitlines())


async def gather(domain: str, use_subfinder: bool = True, timeout: float = 200) -> dict:
    jobs = {
        "crt.sh": fetch_crtsh(domain),
        "agniops": fetch_agniops(domain),
        "crt.name": fetch_crtname(domain),
    }
    if use_subfinder:
        jobs["subfinder"] = run_subfinder(domain)

    async def guarded(name, coro):
        try:
            return name, await coro
        except Exception as e:
            return name, e

    results = await asyncio.wait_for(
        asyncio.gather(*(guarded(name, coro) for name, coro in jobs.items())),
        timeout=timeout,
    )

    by_source: dict[str, list[str]] = {}
    errors: dict[str, str] = {}
    for name, value in results:
        if isinstance(value, Exception):
            errors[name] = f"{type(value).__name__}: {value}"
        else:
            by_source[name] = sorted(value)

    merged: set[str] = set()
    for subs in by_source.values():
        merged.update(subs)

    return {
        "merged": sorted(merged),
        "by_source": by_source,
        "errors": errors,
    }
