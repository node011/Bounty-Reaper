# Hindsight — local agent memory

BountyReaper ships with its own long-term memory backend as a **local Docker service**.
No cloud account, no API key round-trip, and memory survives reinstalls because the data
lives in a Docker volume.

## New system? One command.

```bash
bun script/hindsight.ts up       # builds/pulls + starts, waits for health
```

- API: `http://localhost:8888` — the CLI connects **automatically** (this is the default endpoint)
- UI: `http://localhost:9999` — browse the memory bank
- `bun script/hindsight.ts down` — stop (memories kept)
- `bun script/hindsight.ts doctor` — diagnose

On first `up`, pick the extraction LLM (Hindsight uses it to distill retained text into
facts/observations):

```bash
# Option A — an existing key:
HINDSIGHT_LLM_PROVIDER=openai HINDSIGHT_LLM_API_KEY=sk-... bun script/hindsight.ts up

# Option B — fully local via Ollama (no external key at all):
#   prerequisites: ollama on the host, e.g. `ollama pull qwen3.5:14b`
HINDSIGHT_LLM_PROVIDER=ollama HINDSIGHT_LLM_API_KEY=ollama \
HINDSIGHT_LLM_MODEL=qwen3.5:14b bun script/hindsight.ts up

# Option C — Claude Code / Codex / Cursor / Copilot subscriptions work too
#   (see https://hindsight.vectorize.io/developer/models)
```

## What changes in the CLI

- Default endpoint is now `http://localhost:8888`. With the container running, the
  `hindsight_retain/recall/reflect` tools and auto-recall/retain hooks are ACTIVE with
  **no `/hindsight` key entry at all**.
- If the container is down at session start, the CLI logs it once and the tools say
  `not reachable — run bun script/hindsight.ts up` instead of pretending to work.
- File-backed `memory_*` tools remain the fallback and are untouched.

## Cloud (opt-in)

You can still use Hindsight Cloud — via the `/hindsight` TUI flow (stores the `hsk_...`
key in auth.json) or by exporting `HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io`.
Precedence: `HINDSIGHT_BASE_URL` env > stored cloud key > local default.

## How replication works

Everything stateful is in the `bountyreaper-hindsight-data` volume (declared in the
repo's `docker-compose.yml`). Reinstall the CLI, run `bun script/hindsight.ts up`, and
the bank returns as-is. Moving to a new machine: keep `docker volume` (or copy it, or
use the bank export/import in the Hindsight UI).
