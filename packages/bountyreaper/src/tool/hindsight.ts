import { z } from "zod"
import { Tool } from "./tool"
import { Hindsight } from "../hindsight"
import { HindsightSkillSync } from "../hindsight/skill-sync"

// Explicit Hindsight tools (Cloud or self-hosted). File-backed memory tools
// (memory_search/write/read/context) are unchanged and remain the fallback when
// Hindsight is not configured. These tools always exist but report an honest
// "not configured" state, so a missing key is never mistaken for empty memory.

export const HindsightRetainTool = Tool.define("hindsight_retain", {
  description: `Store a memory in Hindsight (long-term agent memory that learns over time).

Use this to persist durable facts from this engagement for future recall:
- confirmed endpoints/technologies on the current target
- credentials/roles discovered (NEVER secrets in plaintext — describe them)
- decisions, assumptions, and things that worked/didn't
- attack-surface conclusions ("/api/v2/* requires JWT; admin routes under /manage")

Memories are extracted into facts/observations automatically and strengthened
by later retains. Requires Hindsight to be configured (run \`/hindsight\`); if it is
not, this tool reports failure rather than pretending to have stored anything.`,
  parameters: z.object({
    content: z.string().describe("What to remember (plain prose; extraction is automatic)"),
    context: z.string().optional().describe("Optional context label, e.g. 'recon:example.com'"),
    tags: z.array(z.string()).optional().describe("Optional tags for filtering, e.g. ['recon','example.com']"),
  }),
  async execute(params) {
    const meta = { retained: false, tags: params.tags ?? [] }
    const ok = await Hindsight.retain(params.content, params.context, params.tags)
    if (!ok) {
      return {
        title: "Hindsight retain FAILED",
        metadata: meta,
        output:
          "NOT stored. Hindsight is unconfigured or unreachable (check `/hindsight`). Nothing was retained — do not assume this memory will be recalled later.",
      }
    }
    return {
      title: "Hindsight retain queued",
      metadata: { ...meta, retained: true },
      output: `Queued for retention${params.context ? ` (context: ${params.context})` : ""}. It will be extracted into facts/observations in the background.`,
    }
  },
})

export const HindsightRecallTool = Tool.define("hindsight_recall", {
  description: `Search Hindsight memory for anything relevant to the current query.

Combines semantic, keyword (BM25), graph (entity/causal links), and temporal
retrieval with reranking. Use at the start of a new lane or when a target/host
looks familiar — this is how past engagements inform current ones.`,
  parameters: z.object({
    query: z.string().describe("Natural-language query, e.g. 'what do I know about auth on example.com?'"),
    maxTokens: z.number().int().positive().optional().default(2000).describe("Token budget for results (default 2000)"),
  }),
  async execute(params, ctx) {
    if (!Hindsight.configured())
      return {
        title: "Hindsight recall — not configured",
        metadata: { matches: 0, configured: false },
        output: "Hindsight is not configured or is temporarily unreachable. Run `/hindsight` to enable it. This is NOT the same as 'no memories exist'.",
      }
    const text = await Hindsight.recall(params.query, params.maxTokens)
    if (!text)
      return {
        title: "Hindsight recall — no matches",
        metadata: { matches: 0, configured: true },
        output: `Hindsight is connected, but nothing in bank \`${Hindsight.bank()}\` matched this query. Use hindsight_reflect for synthesis across memories.`,
      }
    return { title: "Hindsight recall", metadata: { matches: text.split("\n").length, configured: true }, output: text }
  },
})

export const HindsightReflectTool = Tool.define("hindsight_reflect", {
  description: `Deep synthesis over Hindsight memory: reason across many retained memories to answer a standing question.

Use for questions that need connecting, not lookup:
- "What patterns do my past findings on this org share?"
- "Which asset classes keep producing high-severity bugs for me?"
- "Summarize everything known about this target's auth stack."

Costs an LLM call server-side; prefer hindsight_recall for simple retrieval.`,
  parameters: z.object({
    query: z.string().describe("The question to reason over the whole bank about"),
  }),
  async execute(params, ctx) {
    if (!Hindsight.configured())
      return {
        title: "Hindsight reflect — not configured",
        metadata: { configured: false },
        output: "Hindsight is not configured or is temporarily unreachable. Run `/hindsight` to enable it.",
      }
    const text = await Hindsight.reflect(params.query)
    if (!text)
      return {
        title: "Hindsight reflect — no result",
        metadata: { configured: true },
        output: `Hindsight is connected, but reflect produced no answer for bank \`${Hindsight.bank()}\`. The bank may still be empty — retain some findings first.`,
      }
    return { title: "Hindsight reflect", metadata: { configured: true }, output: text }
  },
})

// omp-parity curation tools: `learn` captures a distilled reuseable LESSON (promotable
// pattern, not a raw event), `memory_edit` updates or soft-retires memories by id —
// all against the same local-first bank.

export const HindsightLearnTool = Tool.define("hindsight_learn", {
  description: `Capture a reusable LESSON into the project memory bank.

A lesson is a distilled, generalizable pattern — not a raw event. Correct form:
- "Flows with parallel sub-agent lanes: seed distinct markers per lane to keep attribution when callbacks arrive"
- "Auth challenge handlers on this stack rotate tokens AFTER the 30x redirect; capture both sides"

Wrong form: "just used X tool", an endpoint, a credential, a session timesheet.
Lessons are consolidated into the bank's standing knowledge document (read at every
session start) and stay scoped to this project. Requires Hindsight to be reachable.`,
  parameters: z.object({
    content: z.string().describe("The distilled lesson, one complete reusable idea per call"),
    tags: z.array(z.string()).optional().describe("Optional extra tags, e.g. ['idor','mcp']"),
  }),
  async execute(params) {
    const ok = await Hindsight.learn(params.content, params.tags)
    if (ok) HindsightSkillSync.refresh().catch(() => {})
    if (!ok) {
      return {
        title: "hindsight_learn FAILED",
        metadata: { learned: false, tags: params.tags ?? [] },
        output:
          "NOT stored. Hindsight is unreachable — run `bun script/hindsight.ts up` and retry. The lesson was not captured. Do not restate it as a lesson in prose alone.",
      }
    }
    return {
      title: "Lesson captured",
      metadata: { learned: true, tags: params.tags ?? [] },
      output: "Lesson queued for retention. It becomes part of this project's standing knowledge on the next consolidation and is auto-compiled into the per-project lessons skill.",
    }
  },
})

export const HindsightEditTool = Tool.define("hindsight_edit", {
  description: `Curate project memory by id: replace a fact's text, FORGET it (soft-retire — excluded from recall and consolidation, reversible), or restore one previously forgotten.

Use when a stored memory is wrong, stale, was captured from a test/env artifact, or
should never have been retained. List ids via hindsight_recall / hindsight_reflect
results (each carries an id). Requires Hindsight reachable.`,
  parameters: z.object({
    memory_id: z.string().describe("Id of the memory to curate"),
    action: z.enum(["update", "forget", "revalidate"]).describe("update = replace text; forget = soft-retire; revalidate = restore"),
    text: z.string().optional().describe("Replacement fact text (action=update only)"),
    reason: z.string().optional().describe("Why (written to provenance)"),
  }),
  async execute(params) {
    const ok = await Hindsight.memoryEdit(params.memory_id, params.action, {
      text: params.text,
      reason: params.reason,
    })
    if (!ok) {
      return {
        title: "hindsight_edit FAILED",
        metadata: { edited: false, id: params.memory_id, action: params.action },
        output:
          "Memory is UNCHANGED. Hindsight is unreachable — run `bun script/hindsight.ts up` and retry. The id may also be wrong; verify via hindsight_recall.",
      }
    }
    return {
      title: "Memory curated",
      metadata: { edited: true, id: params.memory_id, action: params.action },
      output:
        params.action === "update"
          ? "Fact text replaced. Re-embedded and scheduled for re-consolidation."
          : params.action === "forget"
            ? "Memory soft-retired: excluded from future recall and consolidation, kept in the archive. Reversible via action=revalidate."
            : "Memory restored to active recall.",
    }
  },
})
