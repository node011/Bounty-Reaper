"""mythos_reaper.engine.oast — out-of-band sink confirmation for blind probes.

Gate A requires the sink to fire. For BLIND classes (blind SSRF, blind XXE,
cache poisoning on shared infra, blind RCE), the sink fires on an OOB domain.
This module wraps interactsh (preferred, already in the operator's toolkit)
with a deterministic canary -> callback correlation, and mirrors any callback
into mythos-events.jsonl so gate.evaluate sees it.

Fallback when interactsh is unavailable: any attacker-owned logging endpoint
(AgentMail inbox, webhook.site, Burp Collaborator). The contract is only:
  issue(url) -> URL embedding canary;  poll(canary) -> events list
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Callable

CANARY_PREFIX = "mr"


def make_canary() -> str:
    import random
    import string
    return CANARY_PREFIX + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))


def interactsh_available() -> bool:
    try:
        subprocess.run(["interactsh-client", "-v"], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


class OOBClient:
    """interactsh wrapper; falls back to a custom callback base."""

    def __init__(self, callback_base: str | None = None, workdir: str | None = None):
        self.callback_base = callback_base
        self.canary = make_canary()
        self._proc: subprocess.Popen | None = None
        self._log = Path(workdir) / "interactsh.log" if workdir else None
        if callback_base is None and interactsh_available():
            self._start_interactsh()

    def _start_interactsh(self):
        try:
            self._proc = subprocess.Popen(
                ["interactsh-client", "-json"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            self._proc = None

    @property
    def domain(self) -> str:
        if self._proc and self._proc.poll() is None:
            # first line of output is the domain
            if self._log and self._log.is_file():
                for line in self._log.read_text(errors="replace").splitlines():
                    try:
                        rec = json.loads(line)
                        d = rec.get("interactsh_url", "")
                        if d:
                            return d.split("//")[-1].split("/")[0]
                    except Exception:
                        continue
        if self.callback_base:
            return self.callback_base
        raise RuntimeError("no OOB channel: interactsh unavailable and no callback_base")

    def issue(self, tag: str) -> dict:
        """Return an attacker-controlled identifier embedding the canary."""
        sub = f"{tag}.{self.canary}.{self.domain}"
        return {"canary": self.canary, "tag": tag, "host": sub, "url": f"http://{sub}"}

    def poll(self, sink: str, tag: str | None = None) -> list[dict]:
        """Poll for callbacks matching the canary; return gate-compatible events."""
        events = []
        if self._log and self._log.is_file():
            now = time.time()
            for line in self._log.read_text(errors="replace").splitlines():
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                host = json.dumps(rec)
                if self.canary in host and (tag is None or tag in host):
                    events.append({
                        "ts": now,
                        "sink": sink,
                        "oob_callback": True,
                        "type": "oob",
                        "detail": rec,
                    })
        return events

    def close(self):
        if self._proc:
            self._proc.terminate()


def oob_probe_gate(
    oob: OOBClient,
    sink: str,
    send_exploit: Callable[[], dict],
    log: Path,
) -> dict:
    """Drive a blind probe: issue canary → send exploit → poll → write events.

    Returns the events list that gate.evaluate will see for the
    sink_reached / oob_callback checks.
    """
    ident = oob.issue(tag=sink)
    resp = send_exploit()  # request must embed ident["url"] or ident["host"]
    time.sleep(3)  # allow the callback to land
    events = oob.poll(sink=sink)
    for e in events:
        e["exploit_status"] = resp.get("status")
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a") as f:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return {"identity": ident, "events": events, "exploit_response": {
        k: resp.get(k) for k in ("status", "len", "ms", "error")
    }}
