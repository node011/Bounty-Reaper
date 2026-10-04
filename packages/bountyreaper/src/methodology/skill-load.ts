import { Database, eq, and } from "../storage/db"
import { MethodologySkillLoadTable } from "./methodology.sql"
import { Identifier } from "../id/id"
import { Phase } from "./phase"
import { Log } from "../util/log"
import { Skill } from "../skill"

// ============================================================
// SKILL-LOAD TRACKING — evidence for the methodology skill gate
// ============================================================
//
// Every `skill(action=load)` call is recorded here (session-scoped). The
// methodology engine then requires that a phase declaring `requiredSkills`
// has at least ONE loaded skill matching one of its patterns before the
// phase can COMPLETE — so "skills first" is technically enforced, not just
// policy text. Loads are keyed by (session, skill_name); re-loads increment
// the counter so the audit trail keeps "loaded N times" evidence.

export namespace SkillLoad {
  const log = Log.create({ service: "skill-load" })

  export interface Info {
    id: string
    sessionID: string
    skillName: string
    agent?: string
    loads: number
    timeCreated: number
    timeUpdated: number
  }

  function rowToInfo(row: typeof MethodologySkillLoadTable.$inferSelect): Info {
    return {
      id: row.id,
      sessionID: row.session_id,
      skillName: row.skill_name,
      agent: row.agent ?? undefined,
      loads: row.loads,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    }
  }

  /**
   * Record a skill load (upsert per session+skill). Called by the skill tool.
   * Best-effort: evidence recording must never break the skill load itself
   * (e.g. synthetic sessions in tests/one-shots have no session row to FK to).
   */
  export function record(sessionID: string, skillName: string, agent?: string): void {
    const name = skillName.trim().toLowerCase()
    if (!name) return
    try {
      recordUnsafe(sessionID, name, agent)
    } catch (e) {
      log.warn("skill-load record skipped", { sessionID, skill: name, error: String(e) })
    }
  }

  function recordUnsafe(sessionID: string, name: string, agent?: string): void {
    const now = Date.now()
    Database.use((db) => {
      const existing = db
        .select()
        .from(MethodologySkillLoadTable)
        .where(
          and(eq(MethodologySkillLoadTable.session_id, sessionID), eq(MethodologySkillLoadTable.skill_name, name)),
        )
        .get()
      if (existing) {
        db.update(MethodologySkillLoadTable)
          .set({ loads: existing.loads + 1, agent: agent ?? existing.agent, time_updated: now })
          .where(eq(MethodologySkillLoadTable.id, existing.id))
          .run()
      } else {
        db.insert(MethodologySkillLoadTable)
          .values({
            id: Identifier.ascending("methodology_skill_load"),
            session_id: sessionID,
            skill_name: name,
            agent: agent ?? null,
            loads: 1,
            time_created: now,
            time_updated: now,
          })
          .run()
      }
    })
  }

  /** All skills loaded in this session (lowercased names, most recent first). */
  export function loaded(sessionID: string): string[] {
    return Database.use((db) =>
      db
        .select()
        .from(MethodologySkillLoadTable)
        .where(eq(MethodologySkillLoadTable.session_id, sessionID))
        .all()
        .sort((a, b) => b.time_updated - a.time_updated)
        .map((r) => r.skill_name),
    )
  }

  export function list(sessionID: string): Info[] {
    return Database.use((db) =>
      db
        .select()
        .from(MethodologySkillLoadTable)
        .where(eq(MethodologySkillLoadTable.session_id, sessionID))
        .all()
        .map(rowToInfo),
    )
  }

  /** First loaded skill whose name contains any of the patterns (case-insensitive). */
  export function matches(sessionID: string, patterns: string[]): string | undefined {
    if (patterns.length === 0) return undefined
    const names = loaded(sessionID)
    for (const name of names) {
      if (patterns.some((p) => name.includes(p.toLowerCase()))) return name
    }
    return undefined
  }

  /**
   * Resolve concrete skill name(s) from the catalog that would satisfy a gate's
   * patterns. The gate matches on substring, so any catalog skill whose NAME
   * contains one of the patterns satisfies it — this turns "load one matching:
   * recon, enum, crawl" into an exact, copy-pasteable skill(action=load) call.
   * Without this, an agent has to guess a name and cold sessions look stuck.
   */
  export async function suggest(patterns: string[], limit = 3): Promise<string[]> {
    if (patterns.length === 0) return []
    const lowered = patterns.map((p) => p.toLowerCase())
    return (await Skill.all())
      .map((s) => s.name)
      .filter((name) => {
        const n = name.toLowerCase()
        return lowered.some((p) => n.includes(p))
      })
      // Prefer names matching exactly ONE pattern: a skill like "attack-oauth" clears
      // the auth gate and happens to also contain "auth", but a recon-named skill is a
      // clearer instruction for the recon phase. Shorter = less ambiguous.
      .sort((a, b) => {
        const ha = lowered.filter((p) => a.toLowerCase().includes(p)).length
        const hb = lowered.filter((p) => b.toLowerCase().includes(p)).length
        return ha - hb || a.length - b.length || a.localeCompare(b)
      })
      .slice(0, limit)
  }

  /**
   * Skill-gate evaluation for a phase definition.
   * - Phases with no `requiredSkills` always pass.
   * - Otherwise at least one loaded skill must match one required pattern.
   */
  export function satisfied(
    def: Phase.Definition,
    sessionID: string,
  ): { ok: boolean; matched?: string; expected: string[] } {
    const expected = def.requiredSkills ?? []
    if (expected.length === 0) return { ok: true, expected }
    const matched = matches(sessionID, expected)
    return { ok: !!matched, matched, expected }
  }
}
