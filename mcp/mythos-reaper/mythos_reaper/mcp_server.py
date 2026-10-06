"""mythos_reaper.mcp_server — MCP server for bountyreaper.

Bundled with the main bountyreaper repo (mcp/mythos-reaper). Exposes the
mythos-reaper engine as MCP tools so the bountyreaper agent can:
  - score a source tree (white-box mode: sink density 1-5)
  - build a threat model from recon inventory (black-box/gray-box mode)
  - run Gate A probes (baseline vs exploit delta + sink correlation)
  - log events / audits, promote findings (gate-enforced), read status
  - read/write threat-model.json

Runs over stdio. Config entry (bountyreaper.json):
  "mythos-reaper": {
    "type": "local",
    "command": ["uv", "run", "--directory", "<repo>/mcp/mythos-reaper",
                "python", "-m", "mythos_reaper.mcp_server"],
    "enabled": true
  }

Ledger location: $MYTHOS_REAPER_RUNS (if set) else <package>/runs.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from . import gate, oast, scoring, state, threat_model

ENGINE_ROOT = Path(__file__).resolve().parent.parent
BASE = Path(os.environ.get("MYTHOS_REAPER_RUNS", str(ENGINE_ROOT)))

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None

mcp = FastMCP("mythos-reaper") if FastMCP else None


def _reg(name: str, desc: str):
    """Decorator helper that works with or without FastMCP."""
    if mcp is not None:
        return mcp.tool(name=name, description=desc)
    return lambda f: f


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@_reg(
    "mythos_score_source",
    "WHITE-BOX MODE: rank every source file 1-5 by dangerous-sink density "
    "(exec/eval/deserialize/ssrf/sql/fs/path/redirect). Deterministic, offline. "
    "Returns a prioritised audit queue.",
)
def mythos_score_source(
    root: str,
    src_dir: str | None = None,
    top: int = 40,
    min_score: int = 0,
) -> str:
    result = scoring.score_tree(root, src_dir=src_dir, top=top, min_score=min_score)
    rd = state.runs_dir(BASE, Path(root).name)
    (rd / "scores.json").write_text(json.dumps(result, indent=2))
    result["scores_path"] = str(rd / "scores.json")
    return json.dumps(result, indent=2)


@_reg(
    "mythos_build_threat_model",
    "BLACK-BOX/GRAY-BOX MODE: build a threat model from a recon inventory "
    "JSON (endpoints/urls, loose format accepted). Ranks endpoints 1-5 by "
    "attacker-impact heuristics (param classes, auth state, path keywords). "
    "Writes runs/targets/<target>/threat-model.json. The agent then refines "
    "each queue entry's 'hypothesis' field and attaches 'probe_ref'.",
)
def mythos_build_threat_model(
    target: str,
    inventory: str | None = None,
    inventory_json: str | None = None,
    top: int = 50,
) -> str:
    if inventory_json:
        raw = json.loads(inventory_json)
    elif inventory:
        raw = json.loads(Path(inventory).read_text())
    else:
        return json.dumps({"error": "provide inventory (path) or inventory_json (inline)"})
    model = threat_model.build_threat_model(raw, target, top=top)
    p = state.save_threat_model(BASE, target, model)
    model["saved_to"] = str(p)
    return json.dumps(model, indent=2)


@_reg(
    "mythos_refine_queue",
    "Persist agent-refined queue entries back into threat-model.json. Pass the "
    "full refined entries (with 'hypothesis' text and 'probe_ref' pointing at a "
    "probe spec you will write next). Only updates entries by 'rank'.",
)
def mythos_refine_queue(target: str, entries_json: str) -> str:
    model = state.load_threat_model(BASE, target)
    if not model:
        return json.dumps({"error": f"no threat model for {target}; run mythos_build_threat_model first"})
    updates = json.loads(entries_json)
    by_rank = {u.get("rank"): u for u in updates}
    for entry in model["queue"]:
        u = by_rank.get(entry["rank"])
        if u:
            entry.update(u)
    state.save_threat_model(BASE, target, model)
    return json.dumps({"ok": True, "updated": len(by_rank), "model_path": str(state.runs_dir(BASE, target) / "threat-model.json")})


@_reg(
    "mythos_probe",
    "GATE A: execute a probe spec against a live target. Requires BASELINE and "
    "EXPLOIT requests and a CONTROLLED DELTA (exploit must not be explainable "
    "by baseline) plus optional sink/OOB correlation. PASS is mandatory before "
    "any finding may be promoted — this is the anti-hallucination gate. "
    "Returns verdict JSON; also appends to runs/targets/<target>/audit.jsonl.",
)
def mythos_probe(
    target: str,
    spec_json: str,
    base_url: str,
    events_log: str | None = None,
    hypothesis: str = "",
) -> str:
    try:
        spec = json.loads(spec_json)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"bad spec JSON: {e}"})
    log = Path(events_log) if events_log else state.runs_dir(BASE, target) / "mythos-events.jsonl"
    result = gate.run_probe(spec, base_url, log)
    result["hypothesis"] = hypothesis
    state.log_audit(BASE, target, result)
    return json.dumps(result, indent=2)


@_reg(
    "mythos_log_event",
    "Log a sink/OOB event into runs/targets/<target>/mythos-events.jsonl so "
    "Gate A correlation can see it. Use after OOB callbacks land, or when an "
    "instrumented server logged a dangerous-sink call during your exploit.",
)
def mythos_log_event(target: str, sink: str, detail_json: str = "{}", oob: bool = False) -> str:
    try:
        detail = json.loads(detail_json)
    except json.JSONDecodeError:
        detail = {"raw": detail_json}
    rec = {"sink": sink, "oob_callback": bool(oob), "type": "oob" if oob else "sink", "detail": detail}
    state.log_event(BASE, target, rec)
    return json.dumps({"ok": True, "recorded": rec})


@_reg(
    "mythos_promote_finding",
    "PROMOTE a finding to the findings ledger. HARD GATE: refuses unless "
    "finding['probe_result']['verdict'] == 'PASS' with the probe's checks "
    "attached. This is the only path to a 'confirmed' status — parity with "
    "the anti-hallucination rules.",
)
def mythos_promote_finding(target: str, finding_json: str) -> str:
    try:
        finding = json.loads(finding_json)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"bad finding JSON: {e}"})
    try:
        rec = state.promote_finding(BASE, target, finding)
    except ValueError as e:
        return json.dumps({"error": str(e), "verdict_required": "PASS"})
    return json.dumps({"ok": True, "promoted": rec.get("title"), "evidence_sha256": rec.get("evidence_sha256")})


@_reg(
    "mythos_gate_status",
    "Read the target's gate ledger: audits run, PASS/FAIL counts, promoted "
    "findings, event count. Call before deciding where to spend the next probe.",
)
def mythos_gate_status(target: str) -> str:
    return json.dumps(state.gate_status(BASE, target), indent=2)


@_reg(
    "mythos_oob_issue",
    "Issue an out-of-band canary for blind classes (blind SSRF/XXE/cache). "
    "Returns {canary, tag, host, url} — embed the URL in your exploit request, "
    "then call mythos_oob_poll after the exploit to correlate callbacks.",
)
def mythos_oob_issue(callback_base: str | None = None) -> str:
    o = oast.OOBClient(callback_base=callback_base, workdir=str(state.runs_dir(BASE, "oob")))
    ident = o.issue(tag="blind")
    return json.dumps(ident)


@_reg(
    "mythos_oob_poll",
    "Poll the OOB channel for callbacks matching a canary; matched callbacks "
    "are written to mythos-events.jsonl as oob events so mythos_probe's "
    "sink_reached check can see them.",
)
def mythos_oob_poll(canary: str, sink: str, callback_base: str | None = None) -> str:
    o = oast.OOBClient(callback_base=callback_base, workdir=str(state.runs_dir(BASE, "oob")))
    o.canary = canary
    events = o.poll(sink=sink)
    if events:
        for e in events:
            state.log_event(BASE, "oob", e)
    return json.dumps({"canary": canary, "events_found": len(events), "events": events[:10]})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    if mcp is None:
        print("mcp package not installed: uv sync in mcp/mythos-reaper", file=sys.stderr)
        sys.exit(1)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
