import { Database, eq, and, desc, sql } from "../storage/db"
import { CoverageNoteTable } from "./session.sql"
import { Identifier } from "../id/id"

// Append-only coverage memory for the agentic-pentest test loop.
//
// A tester agent, after testing a vuln CLASS at some SCOPE, declares it here via the
// `record_coverage_note` tool. `asset` (the scope id), `class`, and `scope` are all
// LLM-declared generic text/enums — origin/keyHash for web, ARN for cloud, host:port
// for network — so one table serves every lane.
//
// `scope` is the tester's own call:
//  - "wide"  = a property of the whole deployment (JWT/token crypto, TLS, headers,
//    CORS, server version) — recurs across many endpoints, so it is tested ONCE and
//    surfaced to every later request on the same origin (the main cost win).
//  - "local" = specific to this asset (IDOR/injection on one endpoint).
//
// A note's EXISTENCE marks the cell tested. There is NO status column: the verdict
// (vulnerable / clean) lives in intel_entry + vulnerability, not here. RAW process
// memory — append-only, cheap, judgment stays with the agents.
export namespace CoverageNote {
  export type Scope = "wide" | "local"

  /**
   * Coverage dimensions (audit: track WHAT was covered, not just how many
   * cells). Optional — a note may declare the dimension it exercises:
   *  - surface          endpoints/routes/API versions/subdomains tested
   *  - identity         which identity/tenant/role the test ran as
   *  - state            create/read/update/delete/workflow transitions
   *  - input            query/JSON/multipart/headers/cookies/path
   *  - impact           read access/write access/privesc/data disclosure
   *  - validation_depth probe-only / baseline compare / confirmed impact
   */
  export type Dimension = "surface" | "identity" | "state" | "input" | "impact" | "validation_depth"

  export interface Info {
    id: string
    sessionID: string
    asset: string
    class: string
    scope: Scope
    note: string
    testedBy?: string
    requestID?: string
    dimension?: Dimension
    identity?: string
    timeCreated: number
    timeUpdated: number
  }

  export const INJECT_LIMIT = 10 // max wide notes auto-injected into a prompt
  export const PAGE_LIMIT = 20 // max notes returned by get_coverage_notes per page

  /** Append a coverage note (append-only; existence of any row for an (asset, class) marks it tested). */
  export function record(input: {
    sessionID: string
    asset: string
    class: string
    scope: Scope
    note: string
    testedBy?: string
    requestID?: string
    dimension?: Dimension
    identity?: string
  }): Info {
    const id = Identifier.ascending("coverage_note")
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(CoverageNoteTable)
        .values({
          id,
          session_id: input.sessionID,
          asset: input.asset,
          class: input.class,
          scope: input.scope,
          note: input.note,
          tested_by: input.testedBy ?? null,
          request_id: input.requestID ?? null,
          dimension: input.dimension ?? null,
          identity: input.identity ?? null,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
    return {
      id,
      sessionID: input.sessionID,
      asset: input.asset,
      class: input.class,
      scope: input.scope,
      note: input.note,
      testedBy: input.testedBy,
      requestID: input.requestID,
      dimension: input.dimension,
      identity: input.identity,
      timeCreated: now,
      timeUpdated: now,
    }
  }

  function rowToInfo(row: typeof CoverageNoteTable.$inferSelect): Info {
    return {
      id: row.id,
      sessionID: row.session_id,
      asset: row.asset,
      class: row.class,
      scope: (row.scope as Scope) ?? "local",
      note: row.note,
      testedBy: row.tested_by ?? undefined,
      requestID: row.request_id ?? undefined,
      dimension: (row.dimension as Dimension | null) ?? undefined,
      identity: row.identity ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    }
  }

  /** Distinct identity/tenant/role values recorded via dimension=identity notes. */
  export function identities(sessionID: string): string[] {
    const rows = Database.use((db) =>
      db
        .select({ identity: CoverageNoteTable.identity })
        .from(CoverageNoteTable)
        .where(eq(CoverageNoteTable.session_id, sessionID))
        .all(),
    )
    return [...new Set(rows.map((r) => r.identity).filter((v): v is string => !!v && v.trim().length > 0))]
  }

  /** Count of notes per declared dimension (only non-null dimensions). */
  export function dimensionSummary(sessionID: string): Array<{ dimension: string; count: number }> {
    const rows = Database.use((db) =>
      db
        .select({ dimension: CoverageNoteTable.dimension })
        .from(CoverageNoteTable)
        .where(eq(CoverageNoteTable.session_id, sessionID))
        .all(),
    )
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (!r.dimension) continue
      counts.set(r.dimension, (counts.get(r.dimension) ?? 0) + 1)
    }
    return [...counts.entries()].map(([dimension, count]) => ({ dimension, count }))
  }

  /**
   * Paginated query for the `get_coverage_notes` tool. Filters by scope and/or asset.
   * `limit` is clamped to PAGE_LIMIT. Returns the page plus the total matched count so
   * the caller knows whether to page further.
   */
  export function query(input: { sessionID: string; scope?: Scope; asset?: string; offset?: number; limit?: number }): {
    notes: Info[]
    total: number
    offset: number
    limit: number
  } {
    const offset = Math.max(0, input.offset ?? 0)
    const limit = Math.min(input.limit ?? PAGE_LIMIT, PAGE_LIMIT)
    const conds = [eq(CoverageNoteTable.session_id, input.sessionID)]
    if (input.scope) conds.push(eq(CoverageNoteTable.scope, input.scope))
    if (input.asset) conds.push(eq(CoverageNoteTable.asset, input.asset))
    const where = and(...conds)

    const total = Database.use((db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(CoverageNoteTable)
        .where(where)
        .get(),
    )
    const rows = Database.use((db) =>
      db
        .select()
        .from(CoverageNoteTable)
        .where(where)
        .orderBy(desc(CoverageNoteTable.time_created))
        .limit(limit)
        .offset(offset)
        .all(),
    )
    return { notes: rows.map(rowToInfo), total: total?.n ?? 0, offset, limit }
  }

  /** Wide (deployment-wide) notes already recorded for an origin — the auto-injection set. */
  export function wideForAsset(
    sessionID: string,
    asset: string,
    limit = INJECT_LIMIT,
  ): { notes: Info[]; total: number } {
    const total = Database.use((db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(CoverageNoteTable)
        .where(
          and(
            eq(CoverageNoteTable.session_id, sessionID),
            eq(CoverageNoteTable.scope, "wide"),
            eq(CoverageNoteTable.asset, asset),
          ),
        )
        .get(),
    )
    const rows = Database.use((db) =>
      db
        .select()
        .from(CoverageNoteTable)
        .where(
          and(
            eq(CoverageNoteTable.session_id, sessionID),
            eq(CoverageNoteTable.scope, "wide"),
            eq(CoverageNoteTable.asset, asset),
          ),
        )
        .orderBy(desc(CoverageNoteTable.time_created))
        .limit(limit)
        .all(),
    )
    return { notes: rows.map(rowToInfo), total: total?.n ?? 0 }
  }

  /**
   * Formatted prompt block of the app-wide coverage already recorded for an origin,
   * for auto-injection into the orchestrator (skip decision) and the dispatched tester
   * (don't re-test / reuse artifacts). Returns "" when nothing is recorded. Bounded by
   * INJECT_LIMIT; if more exist a "…" line points to get_coverage_notes.
   */
  export function wideBlock(sessionID: string, origin: string): string {
    if (!origin) return ""
    const { notes, total } = wideForAsset(sessionID, origin)
    if (notes.length === 0) return ""
    const lines = [
      `## Coverage so far (app-wide on ${origin} — do NOT re-test these classes here)`,
      ...notes.map((n) => `- [${n.class}] ${n.note}`),
    ]
    if (total > notes.length) {
      lines.push(`- … ${total - notes.length} more — call get_coverage_notes(scope: "wide") for the rest`)
    }
    return lines.join("\n")
  }

  export function listBySession(sessionID: string): Info[] {
    return Database.use((db) =>
      db.select().from(CoverageNoteTable).where(eq(CoverageNoteTable.session_id, sessionID)).all(),
    ).map(rowToInfo)
  }
}
