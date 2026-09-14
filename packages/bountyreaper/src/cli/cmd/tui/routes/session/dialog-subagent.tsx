import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const sync = useSync()

  const root = () => {
    let current = sync.data.session.find((s) => s.id === props.sessionID)
    while (current?.parentID) {
      const parent = sync.data.session.find((s) => s.id === current?.parentID)
      if (!parent) break
      current = parent
    }
    return current?.id ?? props.sessionID
  }

  const family = () => {
    const seen = new Set([root()])
    const queue = [root()]
    const out: typeof sync.data.session = []
    while (queue.length) {
      const id = queue.shift()!
      for (const s of sync.data.session) {
        if (s.parentID !== id || seen.has(s.id)) continue
        seen.add(s.id)
        queue.push(s.id)
        out.push(s)
      }
    }
    return out.sort((a, b) => b.time.updated - a.time.updated)
  }

  const busy = (id: string) => {
    const status = sync.data.session_status?.[id]
    if (!status) return false
    if (status.type === "busy" || status.type === "retry") return true
    return false
  }

  const ago = (ms: number) => {
    const sec = Math.max(1, Math.round(ms / 1000))
    if (sec < 60) return `${sec}s ago`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ago`
    return `${Math.round(min / 60)}h ago`
  }

  return (
    <DialogSelect
      title={`Subagent activity · ${family().filter((s) => busy(s.id)).length} running / ${family().length} total`}
      options={
        family().length
          ? family().map((s) => ({
              title: (s.title || "Untitled").split("\n")[0].slice(0, 60),
              description: `${busy(s.id) ? "running" : "idle"} · updated ${ago(Date.now() - s.time.updated)}`,
              value: s.id,
              onSelect: (dialog: { clear: () => void }) => {
                route.navigate({
                  type: "session",
                  sessionID: s.id,
                })
                dialog.clear()
              },
            }))
          : [
              {
                title: "No subagents in this session yet",
                description: "dispatch work via the task tool to see live activity here",
                value: "none" as const,
                disabled: true,
              },
            ]
      }
    />
  )
}
