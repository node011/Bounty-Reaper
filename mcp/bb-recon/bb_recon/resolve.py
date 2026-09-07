import asyncio
import shutil
import socket

SEM = asyncio.Semaphore(100)


def _parse_dnsx(raw: str) -> dict[str, list[str]]:
    live: dict[str, list[str]] = {}
    for line in raw.splitlines():
        line = line.strip()
        if "[" not in line or "]" not in line:
            continue
        host, _, rest = line.partition("[")
        host = host.strip()
        ips = [ip.strip().rstrip("]") for ip in rest.split(",")]
        ips = [ip for ip in ips if ip]
        if host and ips:
            live[host] = ips
    return live


async def resolve_dnsx(hosts: list[str]) -> dict[str, list[str]] | None:
    if not (shutil.which("dnsx") and hosts):
        return None
    proc = await asyncio.create_subprocess_exec(
        "dnsx",
        "-silent",
        "-a",
        "-resp",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate("\n".join(hosts).encode()), timeout=120)
    except TimeoutError:
        proc.kill()
        return None
    return _parse_dnsx(out.decode())


async def _socket_resolve(host: str) -> tuple[str, list[str]] | None:
    async with SEM:
        try:
            loop = asyncio.get_running_loop()
            infos = await asyncio.wait_for(loop.getaddrinfo(host, None, family=socket.AF_INET), timeout=5)
        except Exception:
            return None
        ips = sorted({info[4][0] for info in infos})
        return host, ips


async def resolve_socket(hosts: list[str]) -> dict[str, list[str]]:
    results = await asyncio.gather(*(_socket_resolve(h) for h in hosts))
    return {host: ips for item in results if item for host, ips in [item]}


async def resolve(hosts: list[str]) -> tuple[dict[str, list[str]], str]:
    via_dnsx = await resolve_dnsx(hosts)
    if via_dnsx is not None:
        return via_dnsx, "dnsx"
    live = await resolve_socket(hosts)
    return live, "socket"
