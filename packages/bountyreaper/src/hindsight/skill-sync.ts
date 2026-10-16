import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Hindsight } from "./index"
import path from "path"
import os from "os"

const log = Log.create({ service: "hindsight-skill-sync" })

/**
 * Auto-skill update — the omp `learn`→managed-skill pipeline with the Hermes
 * auto-refresh pattern.
 *
 * Lessons captured via hindsight_learn are compiled into a per-project SKILL.md under
 * the USER-level skill store (~/.claude/skills/lessons-<project>/) — never inside the
 * repo, so operator hunt artifacts stay out of git and session data never ships. The
 * next session discovers it automatically through the normal skill scan, meaning the
 * lessons survive context loss and gate on their own content going forward.
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

  export function skillDir(): string {
    return path.join(process.env.HOME ?? os.homedir(), ".claude", "skills", `lessons-${projectSlug()}`)
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