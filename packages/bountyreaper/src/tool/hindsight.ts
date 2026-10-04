import { z } from "zod"
import { Tool } from "./tool"
import { Hindsight } from "../hindsight"

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
