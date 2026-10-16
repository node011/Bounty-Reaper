import { Log } from "@/util/log"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Hindsight } from "./index"
import path from "path"

const log = Log.create({ service: "hindsight-skill-sync" })

/**
 * Auto-skill update — the omp `learn`→managed-skill pipeline with the Hermes
 * auto-refresh pattern.
 *
 * Lessons captured via hindsight_learn are compiled into a per-project SKILL.md under
 * BountyReaper's OWN skill tree (<Global.Path.data>/bountyreaper/skill/lessons-<project>/,
 * i.e. ~/.local/share/bountyreaper/skill/) — the directory the bundled skill scanner
 * already reads every session, and NOT a Claude/external store. It is also outside any
 * target repo, so operator hunt artifacts can never ship in git and the next session
 * discovers the lessons automatically through the normal scan.
 *
 * The file is explicitly marked auto-managed: it is regenerated from the bank, so
 * hand edits will be overwritten by the next refresh.
 */
export namespace HindsightSkillSync {
  export const MAX_LESSONS = 60

  function projectSlug(): string {
    let id = "global"
    try {
      id = Instance.project?.id || "global"
    } catch {}
    return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "global"
  }

  /** Pure renderer — exported for tests. */
  export function renderLessons(bankName: string, lessons: string[]): string {
    const items = lessons
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.startsWith("- ") ? l : `- ${l}`))
      .map((l) => `- ${l.slice(2, 400).trim()}`)
    return [
      "---",
      `name: lessons-${bankName}`,
      `description: "Auto-compiled lessons for this project — distilled practices from past hunting sessions. Auto-managed: regenerated from Hindsight, do not hand-edit."`,
      `category: "lessons"`,
      "tags:",
      "  - lessons",
      "  - auto",
      "  - evolving",
      "tech_stack:",
      "  - web",
      "cwe_ids: []",
      "chains_with: []",
      "prerequisites: []",
      "---",
      "",
      `# Project lessons — ${bankName}`,
      "",
      "Distilled from past sessions via hindsight_learn. AUTO-GENERATED from the memory",
      "bank — edit lessons there (hindsight_edit / hindsight_learn), never this file:",
      "refreshes overwrite it.",
      "",
      "## Application rule",
      "",
      "Before testing, scan for a lesson that matches the target shape. A matching lesson",
      "saves a dead lane; an absent one is neutral — probe normally.",
      "",
      `## Lessons (${items.length})`,
      "",
      ...items,
      "",
    ].join("\n")
  }

  /** BountyReaper's own scanned skill tree — global data dir (same home as auth.json). */
  export function skillDir(): string {
    return path.join(Global.Path.data, "skill", `lessons-${projectSlug()}`)
  }

  /**
   * Pull the newest lessons from the project bank and (re)write the auto-skill.
   * Fire-and-forget safe: never throws, returns the path on success.
   */
  export async function refresh(): Promise<string | undefined> {
    if (!Hindsight.enabled() || !Hindsight.configured()) return undefined
    try {
      const lessons = await Hindsight.lessons(MAX_LESSONS)
      if (!lessons?.length) return undefined
      const bank = Hindsight.bank()
      const dir = skillDir()
      await Bun.write(path.join(dir, "SKILL.md"), renderLessons(bank, lessons))
      log.info("lessons skill refreshed", { dir, lessons: lessons.length })
      return dir
    } catch (err) {
      log.warn("lessons skill refresh skipped", { err: String(err).slice(0, 120) })
      return undefined
    }
  }
}

// Module needs Node's os for $HOME fallback in packaged contexts.