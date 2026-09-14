import asyncio
import json
import os
import re
import time
from pathlib import Path

import httpx

from . import cloud, exposure, jsintel, scope
from . import resolve as resolve_mod
from . import sources
from . import takeover
from . import urls as urls_mod

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
PROBE_SEM = asyncio.Semaphore(40)

PHASES = (
    "passive_enum",
    "dns_resolution",
    "url_harvest",
    "http_probe",
    "takeover",
    "exposure",
    "js_intel",
    "cloud_buckets",
)

SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def artifact_dir(domain: str) -> Path:
    base = Path(
        os.environ.get(
            "BB_RECON_OUTPUT_DIR",
            str(Path.cwd() / ".bountyreaper" / "recon"),
        )
    ) / domain.replace("/", "_")
    base.mkdir(parents=True, exist_ok=True)
    return base


def save_artifacts(domain: str, passive: dict, live: dict[str, list[str]]) -> dict[str, str]:
    d = artifact_dir(domain)
    paths = {}
    p = d / "subdomains_passive.json"
    p.write_text(json.dumps(passive, indent=2))
    paths["passive_json"] = str(p)
    p = d / "subdomains.txt"
    p.write_text("\n".join(passive["merged"]))
    paths["subdomains"] = str(p)
    p = d / "live.txt"
    p.write_text("\n".join(f"{h} [{', '.join(ips)}]" for h, ips in sorted(live.items())))
    paths["live"] = str(p)
    return paths


def save_urls(domain: str, urls: list[str]) -> dict[str, str]:
    d = artifact_dir(domain)
    p = d / "urls.txt"
    p.write_text("\n".join(urls))
    return {"urls": str(p)}


def save_report(domain: str, report: dict) -> dict[str, str]:
    d = artifact_dir(domain)
    p = d / "report.json"
    p.write_text(json.dumps(report, indent=2, default=str))
    return {"report": str(p)}


async def _probe(url: str) -> dict | None:
    async with PROBE_SEM:
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=False, verify=False) as c:
                r = await c.get(url)
        except Exception:
            return None
    title = ""
    m = TITLE_RE.search(r.text[:20000])
    if m:
        title = " ".join(m.group(1).split())[:120]
    return {"url": url, "status": r.status_code, "title": title, "server": r.headers.get("server", "")}


async def http_probe(hosts: list[str]) -> list[dict]:
    urls = []
    for h in hosts:
        urls.append(f"https://{h}")
        urls.append(f"http://{h}")
    results = await asyncio.gather(*(_probe(u) for u in urls))
    found = [r for r in results if r]
    found.sort(key=lambda x: (x["url"], x["status"]))
    return found


def summarize(domain: str, passive: dict, live: dict[str, list[str]], resolver: str) -> dict:
    by_source = {k: len(v) for k, v in passive.get("by_source", {}).items()}
    interesting = []
    patterns = ("dev", "staging", "test", "uat", "qa", "admin", "api", "internal", "vpn", "oauth", "auth", "sso", "beta", "preprod", "sandbox")
    for h in passive["merged"]:
        if any(p in h for p in patterns):
            interesting.append(h)
    return {
        "domain": domain,
        "passive_total": len(passive["merged"]),
        "by_source": by_source,
        "source_errors": passive.get("errors", {}),
        "live_total": len(live),
        "resolver": resolver,
        "interesting_envs": sorted(interesting)[:200],
        "interesting_count": len(interesting),
    }


def rank(findings: list[dict]) -> list[dict]:
    return sorted(findings, key=lambda f: (SEVERITY_RANK.get(f.get("severity", "info"), 5), f.get("title", "")))


def _finding(severity: str, title: str, target: str, detail: str, poc: str = "") -> dict:
    return {"severity": severity, "title": title, "target": target, "detail": detail, "poc": poc}


def build_report(domain: str, phases: dict) -> dict:
    """Consolidate every phase into one severity-ranked finding list.

    Applies the triage kill rules at assembly time — a private bucket, a
    credential-less CORS reflection and a low-confidence takeover never reach
    the list, rather than being filtered by whoever reads it.
    """
    findings: list[dict] = []

    for t in phases.get("takeover", {}).get("candidates", []):
        if t["confidence"] != "high":
            continue  # kill: fingerprint or delegation alone is not a takeover
        findings.append(_finding("high", f"Subdomain takeover — {t['service']}", t["host"], t["reason"], t["poc"]))

    exp = phases.get("exposure", {})
    for e in exp.get("exposed", []):
        findings.append(_finding(e["severity"], f"Exposed file {e['path']}", e["url"],
                                 f"{e['content_type']} {e['length']}B — {e['preview'][:80]}", e["poc"]))
    for c in exp.get("cors", []):
        for f in c["findings"]:
            if not f["credentials"]:
                continue  # kill: no ACAC means an attacker page gains nothing
            findings.append(_finding("high", f"CORS {f['kind']} origin with credentials", c["url"],
                                     f["note"], f["poc"]))
    for g in exp.get("graphql", []):
        if not g["introspection_enabled"]:
            continue
        findings.append(_finding("medium", "GraphQL introspection enabled", g["url"],
                                 f"{g['type_count']} types exposed", g["poc"]))

    for s in phases.get("js_intel", {}).get("secrets", []):
        findings.append(_finding(s["severity"], f"Secret in JS — {s['type']}", s["source"],
                                 f"{s['match']} (unvalidated)", s["validate"]))

    for b in phases.get("cloud_buckets", {}).get("exposed", []):
        findings.append(_finding(b["severity"], f"Public {b['provider']} bucket", b["name"],
                                 b["note"], b.get("poc", "")))

    for j in phases.get("juicy_live", []):
        findings.append(_finding("medium", "Archived backup/config file still served", j["url"],
                                 f"{j['content_type']} {j['length']}B", j["poc"]))

    ranked = rank(findings)
    return {
        "findings": ranked,
        "count_by_severity": {
            s: sum(1 for f in ranked if f["severity"] == s)
            for s in ("critical", "high", "medium", "low", "info")
            if any(f["severity"] == s for f in ranked)
        },
        "total": len(ranked),
    }


def coverage(domain: str) -> dict:
    d = artifact_dir(domain)
    p = d / "coverage.json"
    if not p.exists():
        return {"domain": domain, "phases": {ph: "not_run" for ph in PHASES},
                "note": "No pipeline run recorded for this domain yet."}
    state = json.loads(p.read_text())
    done = [k for k, v in state.get("phases", {}).items() if v == "done"]
    return {
        **state,
        "complete": len(done) == len(PHASES),
        "remaining": [ph for ph in PHASES if state.get("phases", {}).get(ph) != "done"],
    }


def save_coverage(domain: str, phases: dict[str, str], started: float) -> None:
    (artifact_dir(domain) / "coverage.json").write_text(json.dumps({
        "domain": domain,
        "phases": phases,
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
    }, indent=2))


async def run_pipeline(domain: str, use_subfinder: bool = True, probe: bool = True, active: bool = True) -> dict:
    started = time.time()
    status = {ph: "skipped" for ph in PHASES}
    phases: dict = {}

    # --- passive ---------------------------------------------------------
    passive = await sources.gather(domain, use_subfinder=use_subfinder)
    status["passive_enum"] = "done"

    live, resolver = await resolve_mod.resolve(passive["merged"])
    status["dns_resolution"] = "done"

    out: dict = summarize(domain, passive, live, resolver)
    out["artifacts"] = save_artifacts(domain, passive, live)
    out["live_sample"] = dict(sorted(live.items())[:100])

    harvest = await urls_mod.harvest(domain)
    buckets = urls_mod.classify(harvest["merged"])
    out["artifacts"].update(save_urls(domain, harvest["merged"]))
    out["urls"] = {
        "total": len(harvest["merged"]),
        "by_source": harvest["by_source"],
        "source_errors": harvest["errors"],
        "juicy_count": len(buckets["juicy_files"]),
        "sensitive_count": len(buckets["sensitive_paths"]),
        "parameterized_count": len(buckets["parameterized"]),
        "ssrf_candidates": buckets["ssrf_candidates"][:30],
        "ssrf_count": len(buckets["ssrf_candidates"]),
    }
    status["url_harvest"] = "done"

    if not active:
        out["report"] = build_report(domain, phases)
        out["phases"] = status
        out["note"] = "Passive phases only (active=False). Set a scope and re-run with active=True for findings."
        save_coverage(domain, status, started)
        out["elapsed_seconds"] = round(time.time() - started, 1)
        return out

    # --- active ----------------------------------------------------------
    try:
        hosts = scope.require(list(live.keys()) or [domain])
    except scope.ScopeError as e:
        out["report"] = build_report(domain, phases)
        out["phases"] = status
        out["scope_error"] = str(e)
        out["note"] = "Active phases skipped: no in-scope targets. Call scope_set first."
        save_coverage(domain, status, started)
        out["elapsed_seconds"] = round(time.time() - started, 1)
        return out

    scope.audit("recon_pipeline", hosts, {"domain": domain})

    if probe:
        out["http"] = await http_probe(hosts)
        status["http_probe"] = "done"

    phases["takeover"] = {"candidates": await takeover.scan(hosts)}
    status["takeover"] = "done"

    # Active per-host probing is the expensive part; cap it and say so rather
    # than silently scanning an estate of thousands.
    top = hosts[:25]
    exp: dict = {"exposed": [], "cors": [], "graphql": []}
    for h in top:
        origin = f"https://{h}"
        exp["exposed"] += await exposure.config_scan(origin)
        c = await exposure.cors_check(origin)
        if c:
            exp["cors"].append(c)
        exp["graphql"] += await exposure.graphql_discover(origin)
    phases["exposure"] = exp
    status["exposure"] = "done"

    scripts: set[str] = set()
    for h in top[:10]:
        d = await jsintel.discover(f"https://{h}")
        scripts.update(d["scripts"])
    in_scope = [s for s in sorted(scripts) if scope.check(s)["in_scope"]][:60]
    phases["js_intel"] = await jsintel.analyze(in_scope)
    status["js_intel"] = "done"

    phases["cloud_buckets"] = await cloud.enumerate_buckets(domain)
    status["cloud_buckets"] = "done"

    if buckets["juicy_files"]:
        phases["juicy_live"] = await urls_mod.probe_juicy(
            [u for u in buckets["juicy_files"] if scope.check(u)["in_scope"]]
        )

    out["hosts_actively_scanned"] = len(top)
    out["hosts_in_scope"] = len(hosts)
    if len(hosts) > len(top):
        out["truncation_note"] = (
            f"Active phases covered the first {len(top)} of {len(hosts)} in-scope hosts. "
            "Call exposure_scan / js_intel directly with a host list to cover the rest."
        )
    out["phases_detail"] = phases
    out["report"] = build_report(domain, phases)
    out["phases"] = status
    out["artifacts"].update(save_report(domain, out["report"]))
    save_coverage(domain, status, started)
    out["elapsed_seconds"] = round(time.time() - started, 1)
    return out
