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

- **Local is THE default memory.** Unless you explicitly set an endpoint, the CLI talks
  to `http://localhost:8888` — a previously stored cloud key cannot flip it back to
  cloud (`HINDSIGHT_LOCAL=1` additionally pins local over any base URL). With the
  container running, the `hindsight_retain/recall/reflect` tools and auto-recall/retain
  hooks are ACTIVE with **no `/hindsight` key entry at all**.
- If the container is down at session start, the CLI logs it once and the tools say
  `not reachable — run bun script/hindsight.ts up` instead of pretending to work.
- File-backed `memory_*` tools remain the fallback and are untouched.

## Curated memory (omp-style)

The agent curates the bank instead of just dumping events into it:

1. **Settled knowledge loads itself.** At the first turn of every session, the CLI reads
   the bank's `project-durable` mental model — a standing document Hindsight maintains
   about targets, confirmed findings, what worked/what failed, and reusable lessons —
   and injects it into the system prompt. That read is a pure database read server-side:
   no retrieval, no LLM call, no latency tax.
2. **`hindsight_learn`** captures a distilled reusable LESSON (a pattern, not an event).
   Lessons are excluded from secret-sniffing scope by design of what they should contain.
3. **`hindsight_edit`** curates by id: replace a fact's text, FORGET it (soft-retired —
   excluded from recall/consolidation, reversible), or restore one.
4. The doc refreshes itself **server-side**: after every observations consolidation,
   with a delta-edit mode and a 30-minute refresh floor so a burst of retains costs one
   refresh, not one per retain.

## Cloud (opt-in)

You can still use Hindsight Cloud — via the `/hindsight` TUI flow (stores the `hsk_...`
key in auth.json) or by exporting `HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io`.
Cloud is opt-in ONLY: set `HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io` AND
supply the key (`/hindsight` flow or `HINDSIGHT_API_KEY`). A stored key alone never
reroutes to cloud.

## How replication works

Everything stateful is in the `bountyreaper-hindsight-data` volume (declared in the
repo's `docker-compose.yml`). Reinstall the CLI, run `bun script/hindsight.ts up`, and
the bank returns as-is. Moving to a new machine: keep `docker volume` (or copy it, or
use the bank export/import in the Hindsight UI).
