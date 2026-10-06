---
name: attack-file-upload
description: "File upload router — map the validation layer first, then load the variant sub-skill (validation-bypass / polyglot-rce / doc-xml-svg / traversal-metadata)"
category: "input-validation"
version: "2.0"
author: "bountyreper-official"
tags:
  - file-upload
  - rce
  - xss
  - bypass
  - polyglot
tech_stack:
  - web
  - php
cwe_ids:
  - CWE-434
  - CWE-122
chains_with:
  - attack-ssrf
  - attack-xss-stored
prerequisites: []
---

# File Upload Router

## Route first — load the variant sub-skill

Upload testing splits by WHERE you expect the code to execute. Determine the layer,
load the sub-skill, work from it:

| Goal / observation | Variant | Load |
|---|---|---|
| Upload succeeds but wrong ext/MIME rejected — want the file SAVED | Validation bypass | `skill(action="load", name="attack-upload-bypass")` |
| Executable content must SURVIVE (polyglot, magic bytes, PHP eval) | Polyglot / RCE | `skill(action="load", name="attack-upload-polyglot")` |
| Upload target is a document parser (XML/SVG/PDF) — parser attacks | Document XML/SVG | `skill(action="load", name="attack-upload-doc-xml")` |
| Filename/path controls storage location | Traversal / metadata | `skill(action="load", name="attack-upload-traversal")` |

## Map the upload surface (always first)

1. Which fields accept files? (avatar, import, export, attachments, editor assets, API
   `multipart` endpoints from the SPA's traffic — Interceptor's passive capture lists them)
2. What happens client-side vs server-side: disable JS → does the upload still reject?
3. Where does the file LAND? (URL returned → open it; note the served Content-Type)
4. Does the file EXECUTE or RENDER? (a saved .jpg that renders raw = different bug class)

## Evidence rule

- Upload rejection bypass WITHOUT execution = candidate only
- Confirmed requires: file served with attacker-chosen content (XSS on your file's URL)
  or code execution visible server-side (phpinfo/calc/output in response or OOB hit)

## References

- [HowToHunt — File Upload](https://github.com/KathanP19/HowToHunt/tree/master/File_Upload) (GPL-3.0)
