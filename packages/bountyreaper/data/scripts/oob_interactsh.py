#!/usr/bin/env python3
"""OOB interaction collector (DEFAULT OOB channel — use this, not Burp Collaborator,
unless the operator explicitly names Burp). Wraps the interactsh-client binary:
`new` backgrounds a session and prints the payload domain; `poll` prints decoded
interactions since last poll; `stop` kills the session. State lives in a dir
(default: fresh mkdtemp) so concurrent lanes never share a correlation."""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

DOMAIN_RE = re.compile(r"([a-z0-9][a-z0-9\-]{5,63}\.[a-z0-9.\-]{3,80})", re.IGNORECASE)


def find_binary():
    found = shutil.which("interactsh-client")
    if not found:
        print("ERROR: interactsh-client not on PATH. Run ensure_tools for interactsh-client first.", file=sys.stderr)
        sys.exit(2)
    return found


def state_paths(state):
    return {
        "dir": state,
        "pid": os.path.join(state, "client.pid"),
        "out": os.path.join(state, "stdout.log"),
        "events": os.path.join(state, "events.jsonl"),
        "offset": os.path.join(state, "poll.offset"),
    }


def cmd_new(args):
    binary = find_binary()
    state = args.state or tempfile.mkdtemp(prefix="oob-interactsh-")
    os.makedirs(state, exist_ok=True)
    paths = state_paths(state)
    cmd = [binary, "-n", "1"]
    if args.server:
        cmd += ["-server", args.server]
    log = open(paths["out"], "a")
    proc = subprocess.Popen(
        cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True, env={**os.environ, "NO_COLOR": "1"},
    )
    with open(paths["pid"], "w") as f:
        f.write(str(proc.pid))
    domain = None
    deadline = time.time() + 30
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            with open(paths["out"], errors="replace") as f:
                text = f.read()
        except FileNotFoundError:
            text = ""
        for line in text.splitlines():
            if "interactsh" in line.lower() or "oast" in line.lower() or "projectdiscovery" in line.lower():
                continue
            m = DOMAIN_RE.search(line)
            if m and "." in m.group(1) and not m.group(1).startswith("github."):
                domain = m.group(1).strip().strip(".")
                break
        if domain:
            break
        time.sleep(1)
    if not domain:
        print(json.dumps({"ok": False, "error": "no payload domain in client output (30s)", "state": state}))
        try:
            with open(paths["out"], errors="replace") as f:
                print("--- client output ---")
                print(f.read()[-2000:])
        except FileNotFoundError:
            pass
        sys.exit(1)
    print(json.dumps({"ok": True, "payload_domain": domain, "state": state, "pid": proc.pid}, indent=2))


def read_offset(paths):
    try:
        with open(paths["offset"]) as f:
            return int(f.read().strip() or 0)
    except (FileNotFoundError, ValueError):
        return 0


def cmd_poll(args):
    paths = state_paths(args.state) if args.state else None
    if not paths or not os.path.isdir(paths["dir"]):
        print(json.dumps({"ok": False, "error": "unknown state dir — run `new` first"}))
        sys.exit(1)
    deadline = time.time() + args.timeout
    found = []
    while True:
        try:
            with open(paths["out"], errors="replace") as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            lines = []
        offset = read_offset(paths)
        fresh = lines[offset:]
        for line in fresh:
            line = line.strip()
            if not line:
                continue
            try:
                found.append(json.loads(line))
            except json.JSONDecodeError:
                if any(k in line.lower() for k in ("dns", "http", "smtp", "ftp", "ldap", "responder", "interaction")):
                    found.append({"raw": line})
        with open(paths["offset"], "w") as f:
            f.write(str(len(lines)))
        if found or time.time() >= deadline:
            break
        time.sleep(2)
    print(json.dumps({"ok": True, "interactions": found, "count": len(found)}, indent=2))


def cmd_stop(args):
    paths = state_paths(args.state) if args.state else None
    if not paths:
        print(json.dumps({"ok": False, "error": "unknown state dir"}))
        sys.exit(1)
    try:
        with open(paths["pid"]) as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        print(json.dumps({"ok": True, "stopped": pid}))
    except (FileNotFoundError, ValueError):
        print(json.dumps({"ok": True, "stopped": None, "note": "no pidfile — nothing running"}))
    except ProcessLookupError:
        print(json.dumps({"ok": True, "stopped": None, "note": "process already gone"}))


def main():
    parser = argparse.ArgumentParser(description="Interactsh OOB collector (default OOB channel)")
    sub = parser.add_subparsers(dest="mode", required=True)
    p_new = sub.add_parser("new", help="Start session, print payload domain + state dir")
    p_new.add_argument("--server", default=None, help="Self-hosted interactsh server URL (default: public)")
    p_new.add_argument("--state", default=None, help="State dir (default: fresh mkdtemp)")
    p_poll = sub.add_parser("poll", help="Print interactions since last poll")
    p_poll.add_argument("--state", required=True, help="State dir from `new`")
    p_poll.add_argument("--timeout", type=int, default=30, help="Wait up to N seconds for hits (default: 30)")
    p_stop = sub.add_parser("stop", help="Kill the background client")
    p_stop.add_argument("--state", required=True, help="State dir from `new`")
    args = parser.parse_args()
    if args.mode == "new":
        cmd_new(args)
    elif args.mode == "poll":
        cmd_poll(args)
    elif args.mode == "stop":
        cmd_stop(args)


if __name__ == "__main__":
    main()
