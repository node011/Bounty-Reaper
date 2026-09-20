# Workflow Gaps Retro — 2026-09-20 (CTF engagement → bug-bounty pipeline)

Source: operator debrief after a CTF engagement run through BountyReaper tooling.
Section A–F first half = session evidence; second half = bug-bounty generalization.
Build items in section D were accepted into the backlog;Bold items ship as defaults.

## A. What the session proves (evidence, not vibes)

| Event | Observable cost | Underlying gap |
|---|---|---|
| Captcha solved by repeated read-PNG round-trips | ~25–30 turns, many TTL failures | No vision-in-loop primitive; no "automate the repeated obstacle" reflex |
| zsteg -a / audit-500 / doc scans | tens of KB into context | No output firewall |
| GraphQL {documents{…}} → 67 KB truncated | flag likely lost in truncation | No redirect→grep discipline |
| 6 parallel subagents → 3 hit step cap | partial results, no resumability | No mission contract / artifact bus |
| Re-solved Khonshu's Eye (already solved) | wasted lane | No solved-ledger / dedup gate |
| Chased {{ get_flag() }} (random per call) | ~15 wasted renders | No honeypot/decoy classifier |
| Used curl instead of mcpbrowser | avoidable manual grind | Approval friction made agent avoid the right tool |
| Reconstructed a summary that conflated two challenges | wrong premises | No ground-truth verification gate |

Bug-bounty generalization: anti-automation blocking recon; HTTP/JS/nuclei output floods;
truncated API dumps losing evidence; stalled lanes; duplicate/out-of-scope work; honeypot
endpoints/canaries/tarpits; bypassing mcpbrowser (no capture → no http_replay evidence);
testing wrong host/path from unverified context.

## B. Skill gaps (agent reasoning)

1. Obstacle-automation reflex — same manual step ≥2× → stop and script it.
2. Output hygiene — never let a tool result be the analysis; default > file → grep/head.
3. Honeypot skepticism — randomized/bait values rejected in ≤2 probes.
4. Tool-selection reasoning — web app + forms/auth ⇒ capture pipeline first.
5. Budget awareness — expiring tokens/sessions acted on in one shot; no breadth-thrash.
6. Evidence-first — baseline→exploit→diff before a finding counts.

## C. Workflow gaps (orchestration)

1. No per-asset/finding Definition of Done (confirmed + reproducible + severity-calibrated).
2. No shared artifact bus (endpoints/params/creds/roles/objects) across lanes.
3. No scope + dedup ledger check before dispatch.
4. No budget governor with checkpoint/resume.
5. No phase gate stopping new work before current is closed or timeboxed.
6. Approval friction inverted tool choice (avoided the right tool rather than asking).

## D. Build items (accepted)

P0 — Output Firewall · Browser/Vision-in-Loop · Finding Pipeline (extract→validate→dedupe→evidence-gate, decoy detector) · Scope+Dedup Ledger.
P1 — Mission Contract · Artifact Bus · Budget Governor · Obstacle-Automation Trigger · Tool-Selection Policy.
P2 — Adversarial Content Guard · Ground-Truth Gate · Approval UX (batch pre-auth) · Stealth/RoE Governor.

**Shipped defaults (this build):**
- Crawling goes through **mcpbrowser** — mandatory first dispatch, inline curl/webfetch recon banned as substitute.
- OOB callbacks default to **interactsh** (`attack_script oob_interactsh`). **Burp Collaborator only on explicit operator mention** — never assumed, never defaulted.

## E. Metrics (prove the fixes)

Turns per obstacle (≤2) · context bytes per finding (<8 KB) · first-tool correctness ·
duplicate/out-of-scope rate (0) · decoy dwell (≤2) · lane completion without caps (>80%) ·
evidence completeness (% with baseline→exploit→diff).

## F. Quick wins vs big bets

Quick wins: Output Firewall · Finding Pipeline · Scope+Dedup Ledger · Mission Contract.
Big bets: Browser/Vision-in-Loop · Artifact Bus · Budget Governor · Adversarial Content Guard.
