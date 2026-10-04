import { createSignal, onMount, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { Hindsight } from "@/hindsight"

/**
 * /hindsight — enable long-term agent memory.
 *
 * Mirrors the provider /connect flow: prompt for the key, persist it via the
 * existing auth store (0600 auth.json), then verify against the API so the user
 * finds out here rather than mid-hunt. Disconnect removes the key and falls
 * back to the built-in file-backed memory tools.
 */
export function DialogHindsight() {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()
  const [verifying, setVerifying] = createSignal(false)
  const [error, setError] = createSignal<string>()

  onMount(async () => {
    const stored = await Hindsight.storedKey().catch(() => undefined)
    if (stored) dialog.replace(() => <ConfirmStep stored={stored} />)
  })

  return (
    <DialogPrompt
      title="Hindsight memory — API key"
      placeholder="hsk_..."
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>
            Hindsight gives BountyReaper long-term memory that learns across sessions: confirmed findings, target
            conclusions, and what worked. Optional — without it, the built-in file memory tools still work.
          </text>
          <text fg={theme.text}>
            Get a key at{" "}
            <span style={{ fg: theme.primary }}>https://ui.hindsight.vectorize.io</span>
          </text>
          <Show when={verifying()}>
            <text fg={theme.textMuted}>Verifying...</text>
          </Show>
          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>
        </box>
      )}
      onConfirm={async (value) => {
        const key = value.trim()
        if (!key) return
        setVerifying(true)
        setError(undefined)
        // Verify BEFORE persisting, so a typo is not silently saved as the memory key.
        const ok = await verify(key)
        setVerifying(false)
        if (!ok) {
          setError("Key rejected by Hindsight — check it and try again.")
          return
        }
        await sdk.client.auth.set({ providerID: Hindsight.AUTH_ID, auth: { type: "api", key } })
        await sdk.client.instance.dispose()
        toast.show({ message: "Hindsight memory enabled", variant: "success" })
        dialog.clear()
      }}
    />
  )
}

async function verify(key: string): Promise<boolean> {
  const { HindsightClient } = await import("@vectorize-io/hindsight-client")
  const c = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL ?? "https://api.hindsight.vectorize.io",
    apiKey: key,
  })
  const res = await c.getVersion().catch(() => undefined)
  return Boolean(res)
}

/** Shown when a key already exists: replace it or disconnect. */
function ConfirmStep(props: { stored: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  return (
    <DialogPrompt
      title="Hindsight memory is enabled"
      placeholder={`key ending …${props.stored.slice(-4)} — type to replace`}
      description={() => <text>Press enter with a new key to replace it, or esc to disconnect.</text>}
      onConfirm={async (value) => {
        const key = value.trim()
        if (!key) return
        if (!(await verify(key))) return
        await sdk.client.auth.set({ providerID: Hindsight.AUTH_ID, auth: { type: "api", key } })
        await sdk.client.instance.dispose()
        toast.show({ message: "Hindsight key replaced", variant: "success" })
        dialog.clear()
      }}
      onCancel={async () => {
        await sdk.client.auth.remove({ providerID: Hindsight.AUTH_ID })
        await sdk.client.instance.dispose()
        toast.show({ message: "Hindsight disconnected — using file memory", variant: "info" })
        dialog.clear()
      }}
    />
  )
}