import type { Hooks, PluginInput } from "@bountyreaper-io/plugin"

/**
 * OpenCode Zen login via API key. Zen free-tier calls made anonymously
 * (`Bearer public`) land in the abuse-gated pool (User-Agent gate,
 * IP policy enforcement); the same calls with the user's own Zen key
 * are recognized account traffic — the same identity the official CLI
 * uses, which is why the official client keeps working where anonymous
 * fork traffic gets rejected.
 *
 * Key source: https://opencode.ai dashboard (Zen API key). Stored in
 * bountyreaper's own auth store (auth.json) by the auth framework.
 */
export async function OpencodeAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "opencode",
      methods: [
        {
          type: "api",
          label: "Zen API Key",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "OpenCode Zen API key (from https://opencode.ai dashboard)",
              placeholder: "opencode_...",
            },
          ],
          authorize: async (inputs) => {
            const key = inputs?.key
            if (!key) return { type: "failed" as const }
            return { type: "success" as const, key }
          },
        },
      ],
    },
  }
}
