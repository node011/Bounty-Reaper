# bb-recon

Recon-to-findings MCP server. Implements the `recon-hunter` skill's pipeline as
tools: passive enumeration through to a severity-ranked finding list with
copyable PoCs.

Pure Python — no Go toolchain, no `waybackurls`/`gau`/`subjack` to install. It
uses `subfinder` and `dnsx` when they happen to be on PATH and falls back to
HTTP and socket resolution when they aren't, so a fresh clone works.

## Scope is mandatory

Every tool that sends a packet to the target refuses to run until scope exists.

```
scope_set(include=["*.target.com"], exclude=["blog.target.com"])
```

Scope lives on disk (`scope.json` in the output directory), not in tool
arguments — a model can ask to test a host, but cannot widen what "in scope"
means. Rules are exact hosts, wildcards (`*.target.com`) or CIDR
(`203.0.113.0/24`).

Loopback, RFC1918, CGNAT and the `169.254.169.254` metadata endpoint are blocked
unless `allow_private=True`, which is for internal engagements only. The
metadata IP stays blocked even if explicitly listed — that is a paste error, not
an intent.

Every active call appends to `audit.jsonl` before the requests go out, so a
killed scan still leaves a record of what it was about to do.

## Tools

| Tool | Phase | Touches target |
| --- | --- | --- |
| `scope_set` / `scope_check` | 0 | no |
| `subdomain_passive` | 1 | no |
| `url_harvest` | 5, 13 | no |
| `subdomain_resolve` | 2 | DNS only |
| `http_probe` | 3 | yes |
| `takeover_scan` | 4 | yes |
| `probe_juicy_files` | 5 | yes |
| `js_intel` | 8 | yes |
| `cloud_buckets` | 10 | provider APIs |
| `exposure_scan` | 11, 12, 14 | yes |
| `recon_pipeline` | all | yes (`active=False` to stay passive) |
| `recon_status` | ledger | no |

## What it will not do

**It never validates a secret it finds.** `js_intel` detects credentials and
attaches the exact command to prove each one live, but does not run it.
Authenticating with a discovered key sends it to a third party, from your IP,
logged on an account nobody in the engagement controls. That is a decision for a
human holding the scope document.

Secret values are masked everywhere they appear — in `match` and in the
surrounding `context` — so a full credential never lands in a model transcript,
a log or a report.

## False positives are the product

A recon tool is worth what its signal-to-noise ratio is, so the triage rules run
at detection time rather than being left to whoever reads the output:

- **Takeover** needs the CNAME delegation *and* the unclaimed fingerprint to
  agree before it is `high`. A bare "404 Not Found" body matches half the
  internet.
- **Exposed files** are checked against a per-host random-path baseline and a
  content signature. `/.git/config` must contain `[core]`; `/.env` must look like
  `KEY=value`. A 200 proves nothing when SPA catch-all routes answer 200 for
  every invented path.
- **CORS** reflection is only reportable with
  `Access-Control-Allow-Credentials: true`. Without it, the attacker page reads
  exactly what an unauthenticated `curl` already reads.
- **Buckets** are reported only when they list anonymously. Exists-but-denied is
  not a finding.
- **Juicy URLs** exclude bare `.json`/`.xml` — every SPA ships `manifest.json`.
- **Parameterised URLs** are deduplicated by (host, path, parameter set), so
  4000 `?id=N` URLs collapse to the one endpoint they represent.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BB_RECON_OUTPUT_DIR` | `./.bountyreaper/recon` | artifacts, `scope.json`, `audit.jsonl` |
| `BB_RECON_SCOPE` | unset | comma-separated scope, used when no `scope.json` exists |
| `BB_RECON_ALLOW_PRIVATE` | unset | `1` to allow reserved ranges via env scope |
| `BB_RECON_CONCURRENCY` | `20` | in-flight requests |
| `BB_RECON_TIMEOUT` | `8` | per-request seconds |
| `BB_RECON_UA` | bb-recon UA | User-Agent |

Concurrency is deliberately modest. A program that rate-limits you is a program
you have stopped testing.

## Development

```bash
uv sync --directory .
uv run --directory . pytest -q
```

Tests are pure functions — scope matching, triage rules, secret masking, source
attribution. No network, so they run in milliseconds and are safe in CI.
