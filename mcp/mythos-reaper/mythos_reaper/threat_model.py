"""mythos_reaper.engine.threat_model — BLACK-BOX / GRAY-BOX mode entry.

When there is no source tree to score, the mythos methodology enters via a
threat model instead of a file ranking. The threat model is stored in
targets/<name>/threat-model.json and plays the same role as scores.json:
it is the prioritised queue the auditor (bountyreaper agent) works through,
with every hypothesis carrying a gate_a_probe pointer.

The deterministic part (this module) does heuristics on the recon inventory.
The LLM part (bountyreaper agent) refines it into concrete attack hypotheses
via the mythos-reaper skill's prompt — the model writes threat-model.json
entries; this module scores/normalises/validates them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Param-name classes that historically pay (ordered by expected hit rate).
PARAM_CLASSES = [
    (r"\b(id|uid|user_id|account|acct|ref|doc|record|item|order|invoice|profile)\b", "idor-prone", 5, "CWE-639"),
    (r"\b(url|uri|redirect|next|return|returnTo|continue|callback|goto|dest|rurl)\b", "redirect/ssrf-prone", 4, "CWE-601/CWE-918"),
    (r"\b(file|path|doc|template|page|include|download|import|lang)\b", "path-traversal/lfi-prone", 4, "CWE-22"),
    (r"\b(q|query|search|filter|sort|order|where|sql)\b", "injection-prone", 4, "CWE-89"),
    (r"\b(email|user|username|login|auth|token|otp|code|verify)\b", "auth/otp-prone", 4, "CWE-287"),
    (r"\b(role|admin|is_admin|permission|scope|premium|tier|plan|price|amount|discount|coupon)\b", "authz/price-prone", 5, "CWE-862"),
    (r"\b(template|preview|render|message|html|content|body|comment)\b", "xss-prone", 3, "CWE-79"),
    (r"\b(graphql|operation|query_name|variables)\b", "graphql-prone", 4, "CWE-各类".replace("各类", "2087")),
]

ENDPOINT_PATTERN = re.compile(r"^(?P<method>GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(?P<path>\S+)$")


def normalise_inventory(raw: dict) -> list[dict]:
    """Accept recon inventory in loose shapes:
      - {"urls": [...]} / {"endpoints": [...]} strings w/ or w/o params
      - {"endpoints": [{method,path,params,auth}]}
    Return normalised endpoint dicts.
    """
    endpoints: list[dict] = []
    items = raw.get("endpoints") or raw.get("urls") or raw.get("routes") or []
    for it in items:
        if isinstance(it, str):
            m = ENDPOINT_PATTERN.match(it.strip())
            if m:
                ep = {"method": m["method"], "path": m["path"], "params": [], "auth": raw.get("auth_default", "unknown")}
            else:
                # bare URL
                ep = {"method": "GET", "path": it.strip(), "params": [], "auth": "unknown"}
                if "?" in ep["path"]:
                    base, qs = ep["path"].split("?", 1)
                    ep["path"] = base
                    ep["params"] = [{"name": k, "value": v or "FUZZ", "source": "query"} for k, v in (kv.split("=", 1) + [""])[:2] for kv in []]  # placeholder
                    ep["params"] = [
                        {"name": kv.split("=", 1)[0], "value": kv.split("=", 1)[1] if "=" in kv else "FUZZ", "source": "query"}
                        for kv in qs.split("&") if kv
                    ]
        elif isinstance(it, dict):
            ep = {
                "method": (it.get("method") or "GET").upper(),
                "path": it.get("path") or it.get("url") or "",
                "params": it.get("params") or [],
                "auth": it.get("auth", "unknown"),
                "notes": it.get("notes", ""),
            }
        else:
            continue
        if ep["path"]:
            endpoints.append(ep)
    # json body params
    for ep in endpoints:
        for p in ep["params"]:
            if isinstance(p, str):
                ep["params"] = [x for x in ep["params"]]
                p_new = {"name": p, "value": "FUZZ", "source": "query"}
                ep["params"][ep["params"].index(p)] = p_new
    return endpoints


def score_endpoint(ep: dict) -> dict:
    score = 0
    reasons: list[str] = []
    cwes: list[str] = []
    params = [p for p in ep["params"] if isinstance(p, dict)]
    for p in params:
        pname = str(p.get("name", "")).lower()
        for rx, label, w, cwe in PARAM_CLASSES:
            if re.search(rx, pname):
                score += w
                reasons.append(f"param:{p.get('name')}→{label}")
                cwes.append(cwe)
                break
    # method weighting
    if ep["method"] in ("POST", "PUT", "PATCH"):
        score += 2
        reasons.append("state-changing method")
    if ep.get("auth") == "none":
        score += 2
        reasons.append("unauthenticated")
    elif ep.get("auth") == "guest":
        score += 3
        reasons.append("guest-accessible (elevated surface)")
    # path heuristics
    path_l = ep["path"].lower()
    for kw, label, w in [
        ("/admin", "admin path", 4), ("/api/v1", "old api version", 2),
        ("/debug", "debug path", 4), ("/graphql", "graphql", 4),
        ("/.git", "git exposure", 5), ("/backup", "backup", 4),
        ("/export", "export", 3), ("/import", "import", 3),
        ("/upload", "upload", 4), ("/profile", "profile", 2),
        ("/sso", "sso", 3), ("/oauth", "oauth", 4), ("/callback", "callback", 3),
        ("/webhook", "webhook", 3), ("/internal", "internal", 4),
    ]:
        if kw in path_l:
            score += w
            reasons.append(label)
    return {
        "endpoint": f'{ep["method"]} {ep["path"]}',
        "score": min(score, 5),
        "reasons": reasons,
        "candidate_cwes": sorted(set(cwes)),
        "params": params,
        "auth": ep.get("auth", "unknown"),
    }


def build_threat_model(inventory: dict, target_name: str, top: int = 50) -> dict:
    eps = normalise_inventory(inventory)
    scored = [score_endpoint(e) for e in eps]
    scored.sort(key=lambda r: (-r["score"], r["endpoint"]))
    top_eps = scored[:top]
    vuln_class_density: dict[str, int] = {}
    for r in scored:
        for cwe in r["candidate_cwes"]:
            key = cwe.split("/")[0]
            vuln_class_density[key] = vuln_class_density.get(key, 0) + 1
    model = {
        "target": target_name,
        "mode": "graybox",
        "endpoints_analysed": len(scored),
        "queue": [
            {
                "rank": i + 1,
                **r,
                "hypothesis": "",
                "probe_ref": "",
                "status": "queued",
            }
            for i, r in enumerate(top_eps)
        ],
        "vuln_class_density": dict(sorted(vuln_class_density.items(), key=lambda kv: -kv[1])),
    }
    return model


def main(argv=None) -> int:
    import argparse
    import sys
    ap = argparse.ArgumentParser(prog="mythos-reaper threat-model")
    ap.add_argument("inventory", help="JSON inventory file (endpoints/urls)")
    ap.add_argument("--target", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--top", type=int, default=50)
    a = ap.parse_args(argv)
    raw = json.loads(Path(a.inventory).read_text())
    model = build_threat_model(raw, a.target, a.top)
    print(json.dumps(model, indent=2))
    if a.out:
        Path(a.out).write_text(json.dumps(model, indent=2))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
