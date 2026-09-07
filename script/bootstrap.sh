#!/usr/bin/env bash
# One-shot setup for a fresh clone. Idempotent — safe to re-run.
#
#   ./script/bootstrap.sh          # everything
#   ./script/bootstrap.sh --no-cli # skip the external recon binaries
#
# Installs: JS deps, a venv per bundled MCP server, Chromium for the browser
# tooling, and (optionally) the recon CLIs the agent shells out to.

set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  warn "$1 not found — $2"
  return 1
}

# GNU coreutils `timeout` is not on a stock macOS; Homebrew installs it as
# `gtimeout`. Absent both, the caller runs the command unbounded.
have_timeout() { command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; }
run_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else gtimeout "$@"; fi
}

bold "1/6  Checking prerequisites"
missing=0
need bun "install from https://bun.sh" || missing=1
need uv "install from https://docs.astral.sh/uv/ (needed for every bundled MCP server)" || missing=1
need git "install git" || missing=1
[ "$missing" -eq 1 ] && { echo; echo "Install the tools above, then re-run."; exit 1; }
ok "bun $(bun --version), uv $(uv --version | awk '{print $2}')"

bold "2/6  Installing JS dependencies"
bun install
ok "workspace installed"

bold "3/6  Setting up bundled MCP servers"
for dir in "$root"/mcp/*/; do
  [ -f "$dir/pyproject.toml" ] || continue
  name=$(basename "$dir")
  uv sync --directory "$dir" --quiet
  ok "mcp/$name"
done

bold "4/6  Installing Chromium"
# Both targets are required: chromium.launch() defaults to headless, which uses
# chrome-headless-shell, not the full browser. Installing only "chromium" leaves
# every headless test failing with "Executable doesn't exist".
# hackbrowser resolves playwright at runtime from the worker's directory.
#
# Bounded, because `playwright install` can hang indefinitely: a stale
# `__dirlock` blocks it forever, and its unzip stream sometimes stalls after the
# download completes. Neither is fatal here — the hackbrowser tool installs
# Chromium on first use — but an unbounded hang stops bootstrap dead, which is.
# See docs/SETUP.md for recovering a stalled install by hand.
rm -rf "${HOME}/Library/Caches/ms-playwright/__dirlock" 2>/dev/null || true
# `|| pw=$?` is load-bearing: under `set -e` a bare failing command here aborts
# bootstrap before the case below can downgrade it to a warning.
pw=0
if have_timeout; then
  run_timeout 600 bunx playwright install chromium chromium-headless-shell >/dev/null 2>&1 || pw=$?
else
  bunx playwright install chromium chromium-headless-shell >/dev/null 2>&1 || pw=$?
fi
case "$pw" in
  0) ok "chromium + headless shell" ;;
  124) warn "chromium install timed out — see docs/SETUP.md; hackbrowser will retry on first use" ;;
  *) warn "chromium install failed ($pw) — the hackbrowser tool will auto-install on first use" ;;
esac

bold "5/6  Registering MCP servers globally"
# Project config only applies inside this repo; global config applies everywhere.
bun run "$root/script/install-mcp.ts" | sed 's/^/  /'

bold "6/6  Local config"
if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env created from .env.example — fill in your keys"
else
  ok ".env already exists (left untouched)"
fi
mkdir -p .bountyreper/recon
ok "artifact directories"

if [ "${1:-}" != "--no-cli" ]; then
  echo
  bold "Optional: external recon binaries"
  echo "  The agent shells out to these. Missing ones simply disable"
  echo "  the matching tools — nothing else breaks."
  for t in nmap nuclei ffuf sqlmap subfinder httpx katana amass dalfox; do
    if command -v "$t" >/dev/null 2>&1; then ok "$t"; else warn "$t missing"; fi
  done
  echo
  echo "  Install them with your package manager, or inside BountyReper run:"
  echo "    ensure_tools"
fi

echo
bold "Done."
echo "  Start with:  bun dev"
echo "  Docs:        docs/SETUP.md"
