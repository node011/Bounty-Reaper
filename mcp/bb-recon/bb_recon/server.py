from mcp.server.fastmcp import FastMCP

from . import cloud, exposure, jsintel, pipeline, resolve as resolve_mod, scope, sources, takeover, urls as urls_mod

mcp = FastMCP("bb_recon")

MAX_SAMPLE = 200


def _denied(e: scope.ScopeError) -> dict:
    return {
        "error": "out_of_scope",
        "detail": str(e),
        "fix": "Call scope_set with the program's in-scope assets before running active tools.",
    }


# ---------------------------------------------------------------- scope


@mcp.tool()
async def scope_set(
    include: list[str],
    exclude: list[str] | None = None,
    allow_private: bool = False,
) -> dict:
    """Define the engagement scope. Required before any active tool will run.

    Accepts exact hosts (api.example.com), wildcards (*.example.com) and CIDR
    ranges (10.0.0.0/24). Persisted to scope.json in the recon output directory
    and applied to every subsequent active call, so scope is set once by the
    operator rather than passed per-request.

    Set allow_private=True only for an internal engagement — it lifts the block
    on loopback, RFC1918 and the 169.254.169.254 metadata endpoint.
    """
    saved = scope.save(include, exclude, allow_private)
    scope.audit("scope_set", saved["include"], {"exclude": saved["exclude"], "allow_private": allow_private})
    return saved


@mcp.tool()
async def scope_check(targets: list[str]) -> dict:
    """Test targets against the current scope without touching them.

    Use before reporting or pivoting to a host you found during enumeration —
    a subdomain sweep routinely turns up assets belonging to third parties.
    """
    current = scope.load()
    verdicts = [scope.check(t, current) for t in targets]
    return {
        "scope": current,
        "in_scope": [v for v in verdicts if v["in_scope"]],
        "out_of_scope": [v for v in verdicts if not v["in_scope"]],
    }


# ---------------------------------------------------------------- passive


@mcp.tool()
async def subdomain_passive(domain: str, use_subfinder: bool = True) -> dict:
    """Passive subdomain enumeration for an apex domain (e.g. example.com).

    Aggregates crt.sh certificate transparency, agniops.in, crt.name and
    subfinder with all sources. Queries third-party archives only — never
    touches the target — so it runs without a scope gate.
    """
    domain = domain.strip().lower().removeprefix("http://").removeprefix("https://").rstrip("/")
    passive = await sources.gather(domain, use_subfinder=use_subfinder)
    artifacts = pipeline.save_artifacts(domain, passive, {})
    return {
        "domain": domain,
        "total": len(passive["merged"]),
        "by_source": {k: len(v) for k, v in passive["by_source"].items()},
        "source_errors": passive["errors"],
        "sample": passive["merged"][:MAX_SAMPLE],
        "truncated": len(passive["merged"]) > MAX_SAMPLE,
        "artifacts": artifacts,
    }


@mcp.tool()
async def url_harvest(domain: str, classify: bool = True) -> dict:
    """Historical URLs from Wayback, AlienVault OTX and URLScan (skill phases 5, 13).

    Passive — reads public archives, does not request anything from the target.
    With classify=True, splits the corpus into juicy files, sensitive paths,
    parameterised endpoints and SSRF candidates.

    Parameterised URLs are deduplicated by (host, path, parameter set), so 4000
    ?id=N URLs collapse to the one endpoint they actually represent.
    """
    domain = domain.strip().lower().removeprefix("http://").removeprefix("https://").rstrip("/")
    harvest = await urls_mod.harvest(domain)
    out = {
        "domain": domain,
        "total": len(harvest["merged"]),
        "by_source": harvest["by_source"],
        "source_errors": harvest["errors"],
        "dropped_offdomain": harvest["dropped_offdomain"],
        "artifacts": pipeline.save_urls(domain, harvest["merged"]),
    }
    if classify:
        buckets = urls_mod.classify(harvest["merged"])
        out["juicy_files"] = buckets["juicy_files"][:MAX_SAMPLE]
        out["juicy_count"] = len(buckets["juicy_files"])
        out["sensitive_paths"] = buckets["sensitive_paths"][:MAX_SAMPLE]
        out["sensitive_count"] = len(buckets["sensitive_paths"])
        out["parameterized_count"] = len(buckets["parameterized"])
        out["ssrf_candidates"] = buckets["ssrf_candidates"][:50]
        out["ssrf_count"] = len(buckets["ssrf_candidates"])
    return out


# ---------------------------------------------------------------- active


@mcp.tool()
async def subdomain_resolve(domain: str, subdomains: list[str] | None = None) -> dict:
    """DNS-resolve subdomains to live A records.

    Uses dnsx when available, falling back to async socket resolution. Omit
    subdomains to run passive enumeration first and resolve everything found.
    """
    domain = domain.strip().lower()
    if not subdomains:
        passive = await sources.gather(domain)
        subdomains = passive["merged"]
    hosts = [s for s in subdomains if s == domain or s.endswith("." + domain)]
    live, resolver = await resolve_mod.resolve(hosts)
    artifacts = pipeline.save_artifacts(domain, {"merged": hosts, "by_source": {}, "errors": {}}, live)
    return {
        "domain": domain,
        "input_count": len(hosts),
        "live_total": len(live),
        "resolver": resolver,
        "live_sample": dict(sorted(live.items())[:MAX_SAMPLE]),
        "truncated": len(live) > MAX_SAMPLE,
        "artifacts": artifacts,
    }


@mcp.tool()
async def http_probe(domain: str, subdomains: list[str] | None = None) -> dict:
    """Probe live web services on subdomains (https + http, status + title).

    Active: sends requests to the target. Out-of-scope hosts are dropped.
    """
    domain = domain.strip().lower()
    if not subdomains:
        passive = await sources.gather(domain)
        live, _ = await resolve_mod.resolve(passive["merged"])
        subdomains = list(live.keys())
    hosts = [s for s in subdomains if s == domain or s.endswith("." + domain)]
    try:
        hosts = scope.require(hosts)
    except scope.ScopeError as e:
        return _denied(e)
    scope.audit("http_probe", hosts)
    results = await pipeline.http_probe(hosts)
    return {"domain": domain, "probed": len(hosts), "responsive": len(results), "results": results[:MAX_SAMPLE]}


@mcp.tool()
async def takeover_scan(hosts: list[str]) -> dict:
    """Subdomain takeover detection (skill phase 4).

    Reports high confidence only when the CNAME delegation and the unclaimed
    service fingerprint agree. A fingerprint on its own is medium; a delegation
    with no fingerprint is low and usually means the site is live and claimed.
    """
    try:
        targets = scope.require([scope.host(h) for h in hosts])
    except scope.ScopeError as e:
        return _denied(e)
    scope.audit("takeover_scan", targets)
    found = await takeover.scan(targets)
    return {
        "checked": len(targets),
        "candidates": found,
        "high_confidence": [f for f in found if f["confidence"] == "high"],
        "note": "Only high-confidence entries are worth reporting without further manual proof.",
    }


@mcp.tool()
async def exposure_scan(targets: list[str], cors: bool = True, graphql: bool = True) -> dict:
    """Exposed config/source, CORS misconfiguration and GraphQL discovery (phases 11, 12, 14).

    Each host gets a random-path baseline first, and every hit must both differ
    from that baseline and match a content signature for the file it claims to
    be — so SPA catch-all routes that answer 200 for any path do not become
    findings.

    CORS reflection is reported as exploitable only with
    Access-Control-Allow-Credentials: true.
    """
    try:
        allowed = scope.require(targets)
    except scope.ScopeError as e:
        return _denied(e)
    origins = [u.rstrip("/") if "://" in u else f"https://{scope.host(u)}" for u in allowed]
    scope.audit("exposure_scan", origins, {"cors": cors, "graphql": graphql})

    out: dict = {"targets": len(origins), "exposed": [], "cors": [], "graphql": []}
    for origin in origins:
        out["exposed"] += await exposure.config_scan(origin)
        if cors:
            c = await exposure.cors_check(origin)
            if c:
                out["cors"].append(c)
        if graphql:
            out["graphql"] += await exposure.graphql_discover(origin)

    out["exposed_count"] = len(out["exposed"])
    out["critical"] = [e for e in out["exposed"] if e["severity"] == "critical"]
    return out


@mcp.tool()
async def js_intel(targets: list[str], max_files: int = 60) -> dict:
    """JavaScript secret and endpoint extraction (skill phase 8).

    Discovers the JS each page loads, fetches the bundles, and mines them for
    credentials, API endpoints and SSR state blobs.

    Secrets are detected, never validated: this tool will not authenticate to a
    third party with a key it just found. Each finding carries the exact
    validation command for you to run once you have confirmed it is in scope.
    """
    try:
        allowed = scope.require(targets)
    except scope.ScopeError as e:
        return _denied(e)
    origins = [u if "://" in u else f"https://{scope.host(u)}" for u in allowed]
    scope.audit("js_intel", origins)

    scripts: set[str] = set()
    ssr: list[dict] = []
    inline: list[dict] = []
    for origin in origins:
        d = await jsintel.discover(origin)
        scripts.update(d["scripts"])
        inline += d.get("inline_secrets", [])
        if d["ssr_state"]:
            ssr.append({"url": d["url"], "state": d["ssr_state"]})

    # Only mine JS served from in-scope hosts; third-party CDN bundles are not
    # the program's asset and their secrets are not the program's to report.
    in_scope_scripts = [s for s in sorted(scripts) if scope.check(s)["in_scope"]][:max_files]
    analysis = await jsintel.analyze(in_scope_scripts)

    analysis["secrets"] = inline + analysis["secrets"]
    analysis["scripts_discovered"] = len(scripts)
    analysis["scripts_analyzed"] = len(in_scope_scripts)
    analysis["scripts_skipped_offscope"] = len(scripts) - len(in_scope_scripts)
    analysis["ssr_state"] = ssr
    return analysis


@mcp.tool()
async def cloud_buckets(domain: str, extra_names: list[str] | None = None, limit: int = 200) -> dict:
    """S3, GCS, Azure Blob and Firebase enumeration from target-derived names (phase 10).

    Reports only buckets that list to an anonymous caller. Buckets that exist
    but deny listing, and names that are unregistered, are returned separately
    and are not findings.
    """
    domain = domain.strip().lower().removeprefix("http://").removeprefix("https://").rstrip("/")
    try:
        scope.require([domain])
    except scope.ScopeError as e:
        return _denied(e)
    scope.audit("cloud_buckets", [domain], {"limit": limit})
    return await cloud.enumerate_buckets(domain, extra_names, limit)


@mcp.tool()
async def probe_juicy_files(urls: list[str], limit: int = 100) -> dict:
    """Check which archived backup/config URLs are still served (phase 5 follow-up).

    HTML responses are discarded — a 200 that returns the SPA shell is not a
    live backup file.
    """
    try:
        allowed = scope.require(urls)
    except scope.ScopeError as e:
        return _denied(e)
    scope.audit("probe_juicy_files", allowed, {"limit": limit})
    live = await urls_mod.probe_juicy(allowed, limit)
    return {"checked": min(len(allowed), limit), "live": live, "live_count": len(live)}


# ---------------------------------------------------------------- pipeline


@mcp.tool()
async def recon_pipeline(
    domain: str,
    use_subfinder: bool = True,
    probe: bool = True,
    active: bool = True,
) -> dict:
    """Full recon-to-findings pipeline for an apex domain.

    Passive: subdomain enumeration -> DNS resolution -> historical URL harvest.
    Active (requires scope, skip with active=False): HTTP probe -> takeover ->
    exposed config/CORS/GraphQL -> JS secrets -> cloud buckets.

    Returns a severity-ranked report with a copyable PoC per finding, and writes
    artifacts under <project>/.bountyreaper/recon/<domain>/ (override with
    BB_RECON_OUTPUT_DIR).
    """
    domain = domain.strip().lower().removeprefix("http://").removeprefix("https://").rstrip("/")
    return await pipeline.run_pipeline(domain, use_subfinder=use_subfinder, probe=probe, active=active)


@mcp.tool()
async def recon_status(domain: str) -> dict:
    """Phase coverage for a domain — which of the pipeline's phases have run.

    Backs the skill's coverage ledger: recon is not done until every phase has
    either produced a result or been explicitly skipped.
    """
    return pipeline.coverage(domain)


def main():
    mcp.run()


if __name__ == "__main__":
    main()
