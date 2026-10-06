---
name: attack-graphql
description: "GraphQL router — locate the endpoint and map the schema, then load the variant sub-skill (recon-introspection / authz / dos-batch / injection-csrf)"
category: "web-application"
version: "2.0"
author: "bountyreper-official"
tags:
  - graphql
  - api
  - introspection
  - dos
  - authz
tech_stack:
  - web
  - graphql
cwe_ids:
  - CWE-200
  - CWE-284
  - CWE-770
chains_with:
  - attack-idor-automation
prerequisites: []
severity_boost:
  attack-idor-automation: "GraphQL introspection reveals IDOR-vulnerable queries"
---

# GraphQL Router

## Route first — load the variant sub-skill

GraphQL bugs split by the attack stage. Map the schema (or discover it's hidden), then
load the matching sub-skill:

| Goal | Variant | Load |
|---|---|---|
| Extract the schema / hunt hidden fields & suggestions | Recon + introspection | `skill(action="load", name="attack-graphql-recon")` |
| Field-level authz bypass, IDOR via object nesting, mass assignment | Authorization | `skill(action="load", name="attack-graphql-authz")` |
| Depth/complexity DoS, batching, alias/amplification abuse | DoS / batching | `skill(action="load", name="attack-graphql-dos")` |
| GET-based queries, CSRF on mutations, subscriptions abuse | Injection / CSRF | `skill(action="load", name="attack-graphql-injection")` |

## Locate the endpoint (always first)

```bash
for ep in /graphql /api/graphql /graphiql /api/graphiql /v1/graphql /query /api/v2/graphql; do
  curl -s -o /dev/null -w "%{http_code} $ep\n" -X POST "https://TARGET$ep" \
    -H "Content-Type: application/json" -d '{"query":"{__typename}"}'
done
# SPA traffic (interceptor inspect) shows the real path + required headers
```

## Proof requirements (all variants)

- Authz findings: TWO accounts, cross-account read/mutation shown (IDs REDACTED if PII)
- DoS findings: request + timing/memory evidence, within program rate limits — DoS
  testing needs explicit program authorization
- Schema recon alone is NOT a finding on most programs — it's your recon step

## Notes

- Multiple GraphQL versions on one host is common (v1 deprecated, still live) — test each
