"""mythos_reaper.engine.scoring — sink-density file ranking (WHITE-BOX mode).

Port of mythos-web score.py / mini-mythos scorer. Rank every source file 1-5
by density of *attacker-reachable dangerous sinks*. Deterministic + offline, no
LLM, fast and reproducible. Output feeds the audit queue: work top-ranked files
first with real instrumentation + Gate A probing.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# (name, regex, weight) — weight = how directly the sink maps to attacker impact.
SINKS = [
    ("rce-exec", re.compile(r"child_process|\bexecSync\b|\bexecFile\b|\bspawnSync?\b|\bos\.(system|popen)\b|subprocess"), 5),
    ("code-eval", re.compile(r"\beval\s*\(|new\s+Function\s*\(|\bvm\.(runIn|compileFunction)|__import__\s*\(|importlib\."), 5),
    ("ssti", re.compile(r"Template\s*\(|render_template_string|Jinja|velocity|freemarker|template\.render"), 5),
    ("deserialize", re.compile(r"unserialize|yaml\.load\s*\(|pickle\.loads|Marshal\.load|decodeReply|unsafeDeserialize"), 5),
    ("ssrf-fetch", re.compile(r"\bfetch\s*\(|https?\.request\s*\(|axios\.|\bundici\b|requests\.get|urlopen"), 4),
    ("sql-exec", re.compile(r"\bexecute\s*\(|rawQuery|sequelize\.literal|cursor\.execute|\bquery\s*\(\s*[a-z_$]+\b"), 4),
    ("fs-write", re.compile(r"writeFileSync|writeFile\s*\(|createWriteStream|rmSync|unlinkSync|Move-Item|shutil\.move"), 3),
    ("fs-read", re.compile(r"readFileSync|readFile\s*\(|createReadStream|sendFile\b|File\.read"), 3),
    ("path-build", re.compile(r"path\.(join|resolve|normalize)\s*\(|os\.path\.join|pathlib\.Path\s*\(|\.\./"), 3),
    ("redirect", re.compile(r"\bredirect\s*\(|setHeader\s*\(\s*['\"]location|Location\s*:|\.redirect\("), 3),
    ("cmd-arg-pass", re.compile(r"process\.argv|sys\.argv|req\.(query|params|body)|request\.GET|request\.POST"), 2),
    ("auth-bypass-prone", re.compile(r"jwt\.decode\s*\(|verify\s*=\s*False|is_admin|role\s*==|requireRole|checkPermission|authorize\s*\("), 2),
    ("crypto-weak", re.compile(r"md5|sha1\b|ECB|random\.random|Math\.random|uuid4|time\.time\s*\(\s*\)\s*as\s*seed"), 2),
    ("prototype-merge", re.compile(r"Object\.assign\s*\(|_\.(merge|defaultsDeep|set)\s*\(|deepMerge|extend\s*\(\s*true"), 3),
    ("xml-parse", re.compile(r"xml\.parse|ElementTree|lxml|etree\.fromstring|xml2js|DOMParser|sax\.parse"), 3),
    ("deser-java", re.compile(r"ObjectInputStream|readObject\s*\(|XMLDecoder|Kryo|Hessian"), 5),
]

CODE_EXT = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java",
    ".kt", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".swift",
    ".lua", ".sh", ".bash", ".ps1",
}
SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "vendor", "venv", ".venv",
    "coverage", "__pycache__", "test", "tests", "fixtures", "examples",
    "docs", "migrations", "bench", ".next", ".output",
}


def iter_source_files(root: Path, src_dir: str | None = None, max_files: int = 5000):
    base = root / src_dir if src_dir else root
    n = 0
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.suffix not in CODE_EXT:
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        n += 1
        if n > max_files:
            break
        yield p


def score_file(path: Path) -> dict:
    try:
        text = path.read_text(errors="replace")
    except Exception:
        return {"file": str(path), "score": 0, "hits": {}}
    hits: dict[str, int] = {}
    raw = 0
    for name, rx, weight in SINKS:
        m = rx.findall(text)
        if m:
            hits[name] = len(m)
            raw += len(m) * weight
    # normalise: 1-5 bands by weighted density per KB
    kb = max(len(text) / 1024, 0.5)
    density = raw / kb
    if raw == 0:
        score = 0
    elif density >= 20:
        score = 5
    elif density >= 10:
        score = 4
    elif density >= 5:
        score = 3
    elif density >= 2:
        score = 2
    else:
        score = 1
    return {"file": str(path), "score": score, "weighted_hits": raw, "hits": hits}


def score_tree(root: str | Path, src_dir: str | None = None, top: int = 40, min_score: int = 0) -> dict:
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        return {"error": f"not a directory: {root}"}
    results = [score_file(p) for p in iter_source_files(root, src_dir)]
    results.sort(key=lambda r: (-r["score"], -r["weighted_hits"], r["file"]))
    ranked = [r for r in results if r["score"] >= min_score][:top]
    return {
        "root": str(root),
        "files_scored": len(results),
        "queue": ranked,
        "summary": {str(s): sum(1 for r in results if r["score"] == s) for s in range(5, 0, -1)},
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mythos-reaper scoring")
    ap.add_argument("root", help="source tree to score")
    ap.add_argument("--src-dir", default=None)
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--min-score", type=int, default=1)
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    result = score_tree(a.root, a.src_dir, a.top, a.min_score)
    print(json.dumps(result, indent=2))
    if a.out:
        Path(a.out).write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
