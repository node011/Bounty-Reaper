"""mythos_reaper.engine.gate — Gate A probe evaluator, mode-agnostic.

A candidate finding only counts when:
  1. An EXPLOIT request produces a CONTROLLED DELTA vs a BASELINE request, and
  2. The intended SINK actually fires (from mythos-events.jsonl within the
     exploit window, optionally correlated out-of-band, or Fallbacked per-report
     for targets we cannot instrument).

Adapted from mythos-web probe.py (Vercel H1 program) which itself adapts from
256thFission/mini-mythos (Anthropic Mythos Preview harness clone). Fixes the
original bug where sink events were not filtered by the exploit window
timestamp.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def http_req(
    url: str,
    method: str = "GET",
    body: str | bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20.0,
) -> dict:
    headers = headers or {}
    data = None
    if body is not None:
        data = body.encode() if isinstance(body, str) else body
        if "Content-Type" not in headers and isinstance(body, str):
            headers.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(url, method=method.upper(), data=data, headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return _ok(url, method, r.status, raw, t0, dict(r.headers))
    except urllib.error.HTTPError as e:
        raw = e.read()
        return _ok(url, method, e.code, raw, t0, dict(e.headers))
    except Exception as e:  # conn refused, timeout, tls, reset
        return {
            "url": url,
            "method": method.upper(),
            "status": None,
            "len": 0,
            "body": "",
            "ms": int((time.time() - t0) * 1000),
            "headers": {},
            "error": f"{type(e).__name__}: {e}",
        }


def _ok(url, method, status, raw, t0, hdrs):
    return {
        "url": url,
        "method": method.upper(),
        "status": status,
        "len": len(raw),
        "body": raw.decode(errors="replace"),
        "ms": int((time.time() - t0) * 1000),
        "headers": hdrs,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Event window filtering
# ---------------------------------------------------------------------------


def read_sink_events(
    log: Path, since_ts: float = 0, sink: str | None = None, limit: int = 50
) -> list[dict]:
    """Pull sink/OOB records written AFTER `since_ts` (the exploit window)."""
    if not log.is_file():
        return []
    out: list[dict] = []
    try:
        for line in log.read_text(errors="replace").splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("ts", 0) < since_ts:
                continue
            if sink and rec.get("sink") != sink:
                continue
            out.append(rec)
    except Exception:
        pass
    return out[-limit:]


# ---------------------------------------------------------------------------
# Verdict evaluation
# ---------------------------------------------------------------------------


def evaluate(spec: dict, baseline: dict, exploit: dict, events: list[dict]) -> dict:
    exp = spec.get("expect", {})
    checks: list[dict] = []

    def add(name, ok, detail):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    if "baseline_status" in exp:
        add(
            "baseline_status",
            baseline["status"] in (
                exp["baseline_status"] if isinstance(exp["baseline_status"], list)
                else [exp["baseline_status"]]
            ),
            f"baseline status={baseline['status']} want {exp['baseline_status']}",
        )

    if "exploit_status" in exp:  # exact status(s) allowed
        want = exp["exploit_status"]
        add(
            "exploit_status",
            exploit["status"] in (want if isinstance(want, list) else [want]),
            f"exploit status={exploit['status']} want {want}",
        )

    if "exploit_not_in" in exp:
        add(
            "exploit_not_in",
            exploit["status"] not in exp["exploit_not_in"],
            f"exploit status={exploit['status']} must NOT be in {exp['exploit_not_in']}",
        )

    if "exploit_contains" in exp:
        for needle in exp["exploit_contains"]:
            add(
                f"exploit_contains:{needle[:40]}",
                needle in exploit["body"],
                f"{'found' if needle in exploit['body'] else 'MISSING'} in exploit body",
            )

    if "exploit_contains_canary" in exp:
        add(
            "exploit_contains_canary",
            exp["exploit_contains_canary"] in exploit["body"],
            "canary reflected in exploit body",
        )

    # A real delta is never explainable by the baseline.
    same_body = baseline["body"] == exploit["body"]
    same_status = baseline["status"] == exploit["status"]
    if same_body and same_status:
        add("delta_exists", False, "exploit response IDENTICAL to baseline — no delta")
    else:
        add(
            "delta_exists",
            True,
            f"baseline {baseline['status']}/{baseline['len']}B vs "
            f"exploit {exploit['status']}/{exploit['len']}B",
        )

    # Sink correlation (only when the target is instrumented / events available).
    sink_window = spec.get("sink_window") or {}
    want = sink_window.get("sink")
    if want:
        hit = [e for e in events if e.get("sink") == want]
        add(
            "sink_reached",
            bool(hit),
            f"{len(hit)} '{want}' event(s) in exploit window"
            + (" (from events log)" if sink_window.get("log_provided") else " (OOB/plate)"),
        )

    # Optional OOB confirmation (out-of-band sink, e.g. SSRF callback).
    oob = spec.get("oob") or {}
    if oob.get("required"):
        hit = [e for e in events if e.get("oob_callback") or e.get("type") == "oob"]
        add("oob_callback", bool(hit), f"{len(hit)} OOB callback(s) in exploit window")

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {
        "verdict": "PASS" if ok else "FAIL",
        "checks": checks,
        "failed": [c["check"] for c in checks if not c["ok"]],
    }


def run_probe(spec: dict, base_url: str, events_log: Path | None = None) -> dict:
    """Execute a full probe: baseline → exploit → sink/OOB event correlation.

    spec keys:
      name, baseline {method,path,headers,body}, exploit {method,path,headers,body},
      expect {...}, sink_window {sink}, oob {required: bool}
    base_url e.g. "http://127.0.0.1:3000" — paths in spec are joined onto it.
    """
    base_url = base_url.rstrip("/")
    b = spec.get("baseline", {})
    x = spec.get("exploit", {})

    b_url = base_url + (b.get("path") or "/")
    x_url = base_url + (x.get("path") or "/")

    # events BEFORE exploit for baseline filter reference
    since = time.time()
    baseline = http_req(b_url, b.get("method", "GET"), b.get("body"), b.get("headers"))
    t_exploit = time.time()
    exploit = http_req(x_url, x.get("method", "GET"), x.get("body"), x.get("headers"))

    events = []
    if events_log:
        events = read_sink_events(events_log, since_ts=t_exploit - 1.5, sink=None)

    verdict = evaluate(spec, baseline, exploit, events)
    return {
        "probe": spec.get("name"),
        "mode": spec.get("mode", "unknown"),
        "verdict": verdict["verdict"],
        "failed_checks": verdict["failed"],
        "baseline": {k: baseline[k] for k in ("status", "len", "ms", "error")},
        "exploit": {k: exploit[k] for k in ("status", "len", "ms", "error")},
        "exploit_body_preview": exploit["body"][:600],
        "checks": verdict["checks"],
        "ts": time.time(),
    }
