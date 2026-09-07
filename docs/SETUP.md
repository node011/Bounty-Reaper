# Setup

Everything BountyReper needs is either in this repo or installed by one script.
A fresh clone should reach a working state with:

```bash
git clone https://github.com/bounty-reper/BountyReper
cd BountyReper
./script/bootstrap.sh
bun dev
```

If that works, you have the same environment as everyone else on the project.
The rest of this document explains what the script does and what is genuinely
optional.

## Prerequisites

The bootstrap script checks for these and stops if any are missing.

| Tool                             | Why                                                    | Install                                            |
| -------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| [bun](https://bun.sh) ≥ 1.3.9    | Runtime and package manager for the whole workspace    | `curl -fsSL https://bun.sh/install \| bash`        |
| [uv](https://docs.astral.sh/uv/) | Runs every bundled MCP server in its own isolated venv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| git                              | Snapshots, worktrees                                   | your package manager                               |

You do **not** need a system Python beyond what `uv` manages, and you do not
need to create any virtualenv by hand.

## What bootstrap does

1. `bun install` — the JS/TS workspace.
2. `uv sync` for each directory under [`mcp/`](../mcp) that has a
   `pyproject.toml`. Each MCP server gets its own `.venv`; they never share
   dependencies and they never touch your global Python.
3. `playwright install chromium chromium-headless-shell` for the workspace (the
   `hackbrowser` crawler). Both targets are needed: `chromium.launch()` defaults
   to headless, which runs the separate `chrome-headless-shell` binary.
4. `script/install-mcp.ts` — registers the bundled MCP servers with BountyReper
   **globally** (see below).
5. Copies `.env.example` to `.env` if you don't have one yet.

It is idempotent. Re-run it after a `git pull` that touches dependencies.

## Why MCP servers are registered globally

There are two separate configs, and mixing them up is the usual reason a server
"doesn't show up":

- [`.mcp.json`](../.mcp.json) is **Claude Code's** config, read when your working
  directory is this repo.
- `~/.config/bountyreper/bountyreper.json` is **BountyReper's global** config,
  read in every folder. `.bountyreper/bountyreper.jsonc` in this repo is
  BountyReper's _project_ config — it only applies inside the repo, so servers
  declared there are missing everywhere else.

Global config needs absolute paths (MCP servers inherit the app's working
directory, and there is no `cwd` option), and absolute paths differ per machine,
so they can't be committed. `script/install-mcp.ts` writes them at install time
from wherever your clone actually sits:

```bash
bun run script/install-mcp.ts            # register (bootstrap does this for you)
bun run script/install-mcp.ts --dry-run  # preview the merged config
bun run script/install-mcp.ts --remove   # unregister
```

It merges rather than replaces, so anything else in your global config survives,
and a server you deliberately disabled stays disabled.

**Moving the repo invalidates the paths — re-run the script after a move.**

## Secrets

Copy [`.env.example`](../.env.example) to `.env` and fill in what you have.
**Every key is optional.** A missing key disables exactly one MCP server; the
agent, the tools, and every other server keep working.

| Variable                 | Enables                                             | Where to get it                   |
| ------------------------ | --------------------------------------------------- | --------------------------------- |
| `CAIDO_PAT`, `CAIDO_URL` | Caido MCP (proxy history, replay, fuzzing)          | Caido → Settings → Authentication |
| `BOUNTYREPER_ROOT`       | Only if you launch the agent from outside this repo | absolute path to your clone       |

`.env` is gitignored. Never commit it, and never put a key in `.mcp.json` —
that file is committed and is read by everyone who clones the repo.

## MCP servers

Four are configured in [`.mcp.json`](../.mcp.json); two of them are bundled in
this repo and need no external setup.

| Server       | Bundled | What it does                                                           |
| ------------ | ------- | ---------------------------------------------------------------------- |
| `bb-recon`   | yes     | Scope-gated recon pipeline: enumeration, takeover, JS secrets, buckets |
| `burpsuite`  | yes     | Bridge to the Burp MCP BApp (needs Burp running, SSE on port 9876)     |
| `caido`      | no      | Proxy history, replay, fuzzing. Needs Caido running + `CAIDO_PAT`.     |
| `pentest-ai` | no      | Scan orchestration. Needs the `ptai` CLI on `PATH`.                    |

The bundled set is deliberately small. Recon and an intercepting proxy are the
two capabilities the agent cannot improvise; everything else it does through its
own built-in tools rather than a third-party MCP server, so a fresh clone has
nothing extra to install and nothing extra to trust.

## Browser capture

Two ways to get traffic in front of the agent:

|            | [Browser extension](../plugins/browser-extension) | [`hackbrowser`](../packages/hackbrowser) |
| ---------- | ------------------------------------------------- | ---------------------------------------- |
| Who drives | you                                               | the agent                                |
| Reaches    | logged-in, past MFA, deep SPA state               | whatever it navigates to unaided         |
| Install    | load unpacked in `chrome://extensions/`           | bundled; nothing to install              |

The extension is a Chromium DevTools panel: browse normally, pick a captured
request, send it for testing. Use it for authenticated surface — hackbrowser
needs a human present for those crawls anyway, so you were going to drive the
browser regardless.

Both hand off through the same `POST /session/ingest`, so results land in an
ordinary session either way.

## Recon binaries

The `ensure_tools` tool installs the standard recon CLIs that the agent shells
out to:
`nmap`, `nuclei`, `ffuf`, `sqlmap`, `subfinder`, `httpx`, `katana`, `amass`,
`dalfox`.

These are **not** required to start. Bootstrap reports which are present and
which are missing; a missing binary disables only the tools that call it.

Install them with your package manager, or from inside BountyReper run the
`ensure_tools` tool — every version it installs is pinned, so two people on the
same engagement get the same scanners.

## Verifying your setup

```bash
bun turbo typecheck    # all packages
bun turbo test         # all packages, including hackbrowser
```

`hackbrowser`'s browser tests need Chromium. If you see
`Looks like Playwright ... was just installed`, run
`bunx playwright install chromium chromium-headless-shell` and re-run.

## Troubleshooting

**A server is missing when you open BountyReper in another folder.** Project
config doesn't travel. Run `bun run script/install-mcp.ts` to register the
bundled servers globally, then restart BountyReper. Check what's registered with
`--dry-run`.

**An MCP server won't start under Claude Code.** `.mcp.json` paths resolve
relative to your current directory. Launch from the repo root, or set
`BOUNTYREPER_ROOT` to an absolute path in `.env`.

**`uv: command not found` when a server starts.** Your editor or agent may not
inherit your shell `PATH`. Launch it from a terminal where `which uv` works.

**Chromium missing at runtime.** The `hackbrowser` tool auto-installs Chromium
on first use, so this normally self-heals. To do it by hand:
`bunx playwright install chromium chromium-headless-shell`.

**`Executable doesn't exist at .../chromium_headless_shell-XXXX`.** You installed
`chromium` but not `chromium-headless-shell`. Install both — see above.

**`playwright install` hangs.** Two different causes, both seen on macOS:

1. _A stale lock._ A killed or concurrent install leaves
   `~/Library/Caches/ms-playwright/__dirlock` behind, and every later install
   waits on it forever. Delete it and retry.
2. _Extraction stalls after the download completes._ The download finishes in
   seconds, then the unzip stream sits on a partly-written directory. Extract the
   archive yourself — the download is still in your temp dir:

   ```bash
   REV=1208   # the revision from the error message
   D=~/Library/Caches/ms-playwright/chromium_headless_shell-$REV
   rm -rf "$D" ~/Library/Caches/ms-playwright/__dirlock && mkdir -p "$D"
   unzip -q "$(ls -t $TMPDIR/playwright-download-*/*.zip | head -1)" -d "$D"
   touch "$D/INSTALLATION_COMPLETE" "$D/DEPENDENCIES_VALIDATED"
   chmod +x "$D"/*/chrome-headless-shell
   ```

   The two marker files matter: Playwright treats a browser directory without
   `INSTALLATION_COMPLETE` as not installed and tries to download it again.
