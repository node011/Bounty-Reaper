---
name: attack-request-smuggling
description: "HTTP request smuggling router — detect desync first, then load the variant sub-skill (CL.TE / TE.CL / TE.TE-obfuscation / H2-and-client-side)"
category: "web-application"
version: "2.0"
author: "bountyreper-official"
tags:
  - request-smuggling
  - http-desync
  - cl-te
  - te-cl
  - h2c
tech_stack:
  - web
cwe_ids:
  - CWE-444
chains_with:
  - attack-cache-poison
  - attack-open-redirect
prerequisites: []
severity_boost:
  attack-cache-poison: "Smuggling + cache = stored XSS/redirect for all users"
---

# HTTP Request Smuggling

## Route first — load the variant sub-skill

Smuggling splits by WHERE the parser disagreement is. Detect desync first (timing
probe below), then load the matching sub-skill for the exploit stage:

| Disagreement | Variant | Load |
|---|---|---|
| Front reads Content-Length, back reads Transfer-Encoding | CL.TE | `skill(action="load", name="attack-smuggling-cl-te")` |
| Front reads Transfer-Encoding, back reads Content-Length | TE.CL | `skill(action="load", name="attack-smuggling-te-cl")` |
| Both parse TE but disagree on obfuscated forms | TE.TE | `skill(action="load", name="attack-smuggling-te-te")` |
| HTTP/2 → HTTP/1 downgrades, or browser-triggered desync | H2 / client-side | `skill(action="load", name="attack-smuggling-h2")` |

## Detect desync first (one timing probe each)

```bash
# CL.TE detector: 5s hang = back-end waiting for more body = front used CL
printf 'POST / HTTP/1.1\r\nHost: TARGET\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nA\r\nX' \
  | timeout 10 nc TARGET 80

# TE.CL detector: hang = front waits (using TE), back consumed early
printf 'POST / HTTP/1.1\r\nHost: TARGET\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n8\r\nSMUGGLED\r\n0\r\n\r\n' \
  | timeout 10 nc TARGET 80
```

Timing alone is not proof — each sub-skill has the confirmation + exploit steps.
Sub-skill files: `cl-te`, `te-cl`, `te-te`, `h2` (under `attack-request-smuggling/`).

## Proof requirements (all variants)

- Differential behavior between two observers (front vs back response split)
- The smuggled request's EFFECT visible (captured response, cache change, auth state)
- HTTP/1.1 evidence — HTTP/2 claims need H2-specific framing, not text probes

## Notes

- Modern stacks: test HTTP/2 routes before raw nc probes — many edge proxies disable
  ambiguous HTTP/1.1 downgrades (see h2 sub-skill first when target advertises h2)
