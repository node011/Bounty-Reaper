"""mythos_reaper.engine.state — append-only event + finding ledgers.

Files (one per target, under runs/<target>/):
  mythos-events.jsonl  — sink/OOB event stream (Gate A correlation source)
  audit.jsonl          — per-candidate audit records (rank, hypothesis, verdict)
  findings.jsonl       — PROMOTED findings only (Gate A PASS). Anything not here
                         is a hypothesis, never a "confirmed" finding.

Rule parity with the operator's .opencode/rules anti-hallucination directive:
a finding's 'confirmed' flag is set by Gate A evidence only, never by an agent.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path


def runs_dir(base: str | Path, target: str) -> Path:
    d = Path(base) / "runs" / "targets" / target
    d.mkdir(parents=True, exist_ok=True)
    return d


def append_jsonl(path: Path, record: dict) -> dict:
    record = dict(record)
    record.setdefault("ts", time.time())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def log_event(base: str | Path, target: str, record: dict) -> dict:
    """Sink or OOB event. Fields: sink, ts, oob_callback, type, detail..."""
    return append_jsonl(runs_dir(base, target) / "mythos-events.jsonl", record)


def log_audit(base: str | Path, target: str, record: dict) -> dict:
    """Audit record. Fields: candidate, rank, hypothesis, verdict, checks..."""
    return append_jsonl(runs_dir(base, target) / "audit.jsonl", record)


def promote_finding(base: str | Path, target: str, finding: dict) -> dict:
    """Promote a finding — REQUIRES the probe verdict + checks to be embedded."""
    probe = finding.get("probe_result") or {}
    if probe.get("verdict") != "PASS":
        raise ValueError(
            "GATE REFUSAL: finding cannot be promoted — probe verdict is "
            f"'{probe.get('verdict')}', not PASS. Run mythos_probe with a valid spec."
        )
    finding = dict(finding)
    finding["confirmed_by_gate"] = True
    finding["gate_ts"] = time.time()
    finding["evidence_sha256"] = hashlib.sha256(
        json.dumps(probe.get("checks", []), sort_keys=True).encode()
    ).hexdigest()[:16]
    return append_jsonl(runs_dir(base, target) / "findings.jsonl", finding)


def gate_status(base: str | Path, target: str) -> dict:
    rd = runs_dir(base, target)
    audits = read_jsonl(rd / "audit.jsonl")
    findings = read_jsonl(rd / "findings.jsonl")
    events = read_jsonl(rd / "mythos-events.jsonl")

    def _verdict(a: dict) -> str | None:
        v = a.get("verdict")
        if v is None:
            v = (a.get("probe_result") or {}).get("verdict")
        return v

    passed = sum(1 for a in audits if _verdict(a) == "PASS")
    failed = sum(1 for a in audits if _verdict(a) == "FAIL")
    return {
        "target": target,
        "audit_records": len(audits),
        "gate_passed": passed,
        "gate_failed": failed,
        "promoted_findings": len(findings),
        "events_logged": len(events),
        "findings": [f.get("title", "<untitled>") for f in findings],
    }


def load_threat_model(base: str | Path, target: str) -> dict | None:
    p = runs_dir(base, target) / "threat-model.json"
    if p.is_file():
        return json.loads(p.read_text())
    return None


def save_threat_model(base: str | Path, target: str, model: dict) -> Path:
    p = runs_dir(base, target) / "threat-model.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(model, indent=2, ensure_ascii=False))
    return p
