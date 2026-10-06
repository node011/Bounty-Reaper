# mythos-reaper — Methodology & Architecture

One engine, two modes, one gate. Adapted from the Mythos Preview methodology
(via 256thFission/mini-mythos → your mythos-web port) and integrated with
bountyreaper as (a) an MCP server the agent calls mid-hunt, and (b) a skill
framing the workflow.

## Provenance

```
Anthropic Mythos Preview (red.anthropic.com)
  → mini-mythos (OSS clone: C/C++, ASan/UBSan, dockerized)
    → mythos-web (your Vercel H1 port: TS/Node, sink-hook preload, live HTTP)
      → mythos-reaper (this: mode-agnostic, bountyreaper-native, MCP)
```

## What was kept vs changed

| mythos-web | mythos-reaper |
|---|---|
| File ranking 1-5 (sink density) | ✅ kept (`mythos_score_source`) + NEW: endpoint ranking from recon inventory (`mythos_build_threat_model`) |
| Docker + NODE_OPTIONS sink-hook | Optional — instrumentation is target-specific. The **events contract** stays: any sink/OOB event lands in `mythos-events.jsonl` |
| Gate A: delta + sink correlation | ✅ kept and strengthened: events are now filtered by the exploit window timestamp (original bug fixed), OOB supported for blind classes |
| Source tree read-only | N/A (bountyreaper runs out-of-container) — the ledger is append-only instead |
| Judge/verifier as separate LLM passes | The bountyreaper agent plays auditor + critic; the ENGINE holds the promotion gate (verdict PASS + checks evidence) |

## The Gate

```
findings.jsonl ← mythos_promote_finding  ← REQUIRES probe verdict PASS
audit.jsonl    ← mythos_probe            ← every attempt logged, PASS or FAIL
mythos-events  ← sink + OOB events       ← correlation source for Gate A
```

A finding's "confirmed" status exists only in `findings.jsonl`, and the only
writer is the gate. Agents cannot assert their way in — same rule as the
operator's `.opencode/rules/01-prime-directive.md`.

## Directory layout

```
mythos-reaper/
├── engine/
│   ├── gate.py          # Gate A: http, evaluate, run_probe (mode-agnostic)
│   ├── scoring.py       # white-box sink-density file ranking
│   ├── threat_model.py  # black-box endpoint ranking + threat model builder
│   ├── state.py         # append-only ledgers (events/audit/findings)
│   ├── oast.py          # OOB canary issue/poll for blind classes
│   └── mcp_server.py    # MCP stdio server (registered in bountyreaper.json)
├── probes/              # spec templates (traversal, blind SSRF, IDOR)
├── runs/targets/<name>/ # scores.json, threat-model.json, *.jsonl
└── docs/
```

## bountyreaper wiring

- MCP: `~/.config/bountyreaper/bountyreaper.json` → `mcp["mythos-reaper"]`
  (stdio, `uv run --directory <repo>/mcp/mythos-reaper python -m mythos_reaper.mcp_server`).
- Skill: repo root `.bountyreaper/skill/mythos-reaper/SKILL.md` — this is a
  **built-in skill**: `publish.ts` bundles it into the npm package and
  `postinstall.mjs` installs it to `~/.local/share/bountyreaper/skill/`.
- Engine location: `mcp/mythos-reaper/` (uv package `mythos-reaper`, console
  script `mythos-reaper-mcp`), packaged alongside the main bountyreaper repo.
- Ledger: `mcp/mythos-reaper/runs/targets/<target>/` (override with
  `MYTHOS_REAPER_RUNS`).

## Design decisions

1. **Engine is deterministic where it can be.** Scoring, delta detection,
   sink correlation, and promotion are code, not model output. The LLM
   (bountyreaper) supplies hypotheses and payloads; the engine supplies proof.
2. **Black-box enters via threat model, not a mode exception.** The threat
   model plays the same role as scores.json: a prioritised queue with
   hypothesis → probe_ref pointers. Everything downstream is identical.
3. **OOB is a first-class sink.** Blind SSRF/XXE/cache can't produce response
   deltas reliably — an OOB callback within the exploit window is the sink
   firing. `mythos-events.jsonl` carries both kinds.
4. **The events-window bug fix matters.** mythos-web's probe.py read events
   `since_ts=0` — any stale event from a previous probe could satisfy
   `sink_reached`. Here the window is `[exploit_start - 1.5s, now]`.
