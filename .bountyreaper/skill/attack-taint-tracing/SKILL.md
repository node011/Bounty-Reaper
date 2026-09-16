---
name: attack-taint-tracing
description: "White-box source-to-sink taint tracing — prove attacker input reaches exec, query, crypto, file, auth, and redirect sinks"
category: "methodology"
version: "1.0"
author: "bountyreper-official"
tags:
  - taint
  - whitebox
  - code-audit
  - reachability
tech_stack:
  - web
  - node
  - python
cwe_ids:
  - CWE-78
  - CWE-89
  - CWE-918
  - CWE-22
  - CWE-639
  - CWE-327
chains_with:
  - recon-methodology
  - attack-sqli
  - attack-javascript-recon
prerequisites: []
---

# Taint Tracing (Source → Sink)

## Objective

A sink grep is not a finding. `exec(`, `$queryRaw`, `fetch(url)`, `update({id})`
appear in every large codebase — 95% are unreachable from attacker input. For
every sink you report, trace the full taint path: **route input → … → sink**,
naming each hop with file:line. No path, no finding — record it as a
CANDIDATE with the missing hop stated explicitly.

## Step 0 — Verify the checkout before auditing

A pruned or sparse tree guarantees false negatives (entire sink classes
invisible). Before any white-box audit:

```bash
git rev-parse HEAD || echo "NO-GIT-HEAD"
find <src> -name "*.ts" | wc -l
find <src> -type d -empty | head
```

Refuse to report "no findings" from a tree with no HEAD, zero files under a
documented source dir, or gutted middleware/lib dirs. Fix the checkout first
(full clone, `checkout-index -f -a`, or sparse-checkout add the missing paths).

## Step 1 — Enumerate sinks by class (all six, every audit)

| Class | Sink patterns | What to open |
|---|---|---|
| Shell exec | `exec(`, `execSync`, `spawn` with `shell:true`, backticks, `os.system`, `popen`, `subprocess` without arg array | The call AND its argument construction site |
| ORM by id | `update({`, `delete(`, `findUnique(`, `upsert(` with `where: { id }` | The id source: `req.params`, `req.body`, or server-generated? |
| Auth boundary | middleware trust (`x-user-id`, `x-s2s-key`, service tokens), middleware bypasses, `TODO`/temporary auth exceptions | Every `if` that skips verification — who can reach that branch? |
| File scope | read/write/grep tools with path args, `..` handling, symlink following, `/proc` access | The path join + normalization + containment check (lexical checks alone fail on symlinks) |
| Crypto | `aes-*-cbc`, `createCipher`, custom envelopes, key storage | Mode (CBC without tag = malleable), IV reuse, key location |
| Redirect/fetch | `fetch(userUrl)`, `res.redirect(x)`, `nextLink` follows, callback/webhook URLs | Guard function: DNS resolve + re-check per hop? redirect policy? |

Plus the query engine: custom sync/query layers (Zero, GraphQL resolvers) need
tenant-scope review at the engine level, not just per route.

## Step 2 — Trace taint backwards from each sink

For each sink, walk backwards:

1. Where does the tainted argument come from? (caller → caller → route)
2. At each hop, is there validation? Allowlist regex? Type coercion? Auth check?
3. Does the route require auth? Which actor (anon, low-priv member, admin)?
4. Is there a second validation layer that re-checks (defense in depth) or does
   one bypass disable the only check?

Record the chain as `route file:line → service file:line → sink file:line`.
If any hop is in a file you cannot open (pruned tree), STOP and mark the
chain UNRESOLVED — do not assert safe or vulnerable.

## Step 3 — Prioritize exploit chains over hygiene

Audit in this order; do not spend budget on dependency lists, Docker USER
directives, or secret-placeholder hygiene until all six sink classes are
traced:

1. Shell exec reachable from request/config input (RCE)
2. Auth-boundary bypass or trust confusion (auth bypass, user oracle)
3. File-scoped tool escape (symlink, traversal, environ read)
4. Crypto misuse on stored secrets (CBC, static IV, key in repo)
5. Fetch/redirect sinks with attacker-influenced URLs (SSRF, metadata)
6. ORM-by-id without ownership check (IDOR/BOLA — needs two accounts to prove)
7. OAuth/token-in-URL leaks (custom schemes, query echo)

## Step 4 — Reconciliation pass (kill list)

After the first pass, run a second pass with the opposite goal:

- **Kill overclaims:** for each finding, re-read the guard you dismissed. If a
  validation layer actually blocks the path, downgrade or drop the finding.
  Common false kills to check: org scoping that needs a memberId you assumed
  absent, S2S middleware you didn't see mounted, allowlists enforced at a
  second layer.
- **Kill underclaims:** for each sink class in Step 1 with zero findings, state
  WHY (traced and safe with the blocking control named, or UNRESOLVED with the
  missing file/hop). A class with neither a finding nor a reason is a missed
  class — go back.

A white-box audit is complete only when every sink class has a finding or a
stated reason. "Grep found nothing" is never a reason.

## Step 5 — Live confirmation (where a lab exists)

Static taint is a hypothesis. Confirm in order of cheapness:

1. Negative control first (benign input blocked/allowed as expected)
2. Benign PoC (`id`, `whoami`, `touch /tmp/<id>`, canary-token fetch)
3. Two-actor proofs for IDOR (second account, low-priv token)
4. Metadata/redirect chains last (packet capture as evidence)

Never test production. Lab network only, isolated, benign payloads.
