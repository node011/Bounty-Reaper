# mythos-reaper MCP

Mythos-style audit harness bundled with bountyreaper. One engine, two modes,
one gate — adapted from Anthropic Mythos Preview (via mini-mythos → mythos-web):

```
WHITE-BOX (source in scope)                BLACK-BOX (no source)
─────────────────────────────              ─────────────────────────
score source tree (sink density)           recon inventory → threat model
audit top-ranked files                     refine queue into hypotheses
candidate → probe spec                     candidate → probe spec
GATE A: delta + sink must fire             GATE A: delta + sink must fire
PASS → findings ledger                     PASS → findings ledger
```

## Setup

```bash
cd mcp/mythos-reaper
uv sync          # creates .venv with mcp
```

Enable in `~/.config/bountyreaper/bountyreaper.json`:

```json
"mythos-reaper": {
  "type": "local",
  "command": ["uv", "run", "--directory", "<repo>/mcp/mythos-reaper",
              "python", "-m", "mythos_reaper.mcp_server"],
  "enabled": true
}
```

Optional env: `MYTHOS_REAPER_RUNS` — ledger directory
(default `<here>/runs/targets/<target>/`).

## Tools

| Tool | Mode |
|---|---|
| `mythos_score_source` | white-box: sink-density file ranking |
| `mythos_build_threat_model` | black-box: endpoint ranking from recon inventory |
| `mythos_refine_queue` | both: persist hypotheses + probe_refs |
| `mythos_probe` | both: **Gate A execution** |
| `mythos_log_event` | both: sink/OOB event stream |
| `mythos_promote_finding` | both: gate-enforced promotion (requires probe PASS) |
| `mythos_gate_status` | both: ledger readback |
| `mythos_oob_issue` / `mythos_oob_poll` | blind classes: canary + callback correlation |

## Ledgers

```
runs/targets/<target>/
├── scores.json          white-box file ranking
├── threat-model.json    black-box endpoint queue (agent-refined)
├── mythos-events.jsonl  sink + OOB event stream (Gate A correlation)
├── audit.jsonl          every probe attempt, PASS or FAIL
└── findings.jsonl       PROMOTED findings only (gate-checked)
```

`mythos_promote_finding` refuses any finding whose
`probe_result.verdict != "PASS"` — promotion is engine-enforced, never
agent-asserted.

See `docs/METHODOLOGY.md` and the `mythos-reaper` skill
(`.bountyreaper/skill/mythos-reaper/`, bundled with the npm package).
