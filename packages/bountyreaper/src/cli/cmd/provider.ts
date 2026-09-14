import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { discoverModels, addProvider, locateProvider, removeProvider, removeModel } from "../../provider/local"
import * as prompts from "@clack/prompts"

export const ProviderCommand = cmd({
  command: "provider",
  describe: "manage local/custom AI providers",

  builder: (yargs) =>
    yargs.command(ProviderAddCommand).command(ProviderListCommand).command(ProviderRemoveCommand).demandCommand(),

  async handler() {},
})

export const ProviderAddCommand = cmd({
  command: "add",
  describe: "add a local/custom OpenAI-compatible provider",

  builder: (yargs: Argv) =>
    yargs
      .option("name", {
        type: "string",
        describe: "provider display name",
      })
      .option("url", {
        type: "string",
        describe: "base URL (e.g. http://192.168.1.201:8000/v1)",
      })
      .option("key", {
        type: "string",
        describe: "API key (optional)",
      })
      .option("scope", {
        type: "string",
        describe: "config scope",
        choices: ["project", "global"] as const,
        default: "project",
      }),

  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const nonInteractive = args.name && args.url

        if (!nonInteractive) {
          UI.empty()
          prompts.intro("Add Local Provider")
        }

        const name =
          args.name ??
          (await (async () => {
            const v = await prompts.text({
              message: "Provider name",
              placeholder: "Local Llama",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(v)) throw new UI.CancelledError()
            return v
          })())

        const baseURL =
          args.url ??
          (await (async () => {
            const v = await prompts.text({
              message: "Base URL",
              placeholder: "http://192.168.1.201:8000/v1",
              validate: (x) => {
                if (!x || !x.length) return "Required"
                try {
                  new URL(x)
                } catch {
                  return "Invalid URL"
                }
              },
            })
            if (prompts.isCancel(v)) throw new UI.CancelledError()
            return v
          })())

        const apiKey =
          args.key ??
          (nonInteractive
            ? undefined
            : await (async () => {
                const v = await prompts.text({
                  message: "API key (leave empty if none)",
                  placeholder: "sk-...",
                })
                if (prompts.isCancel(v)) throw new UI.CancelledError()
                return v || undefined
              })())

        const spinner = prompts.spinner()
        spinner.start("Discovering models...")

        let models
        try {
          models = await discoverModels(baseURL, apiKey)
        } catch (e) {
          spinner.stop("Failed to discover models")
          const msg = e instanceof Error ? e.message : String(e)
          prompts.log.error(msg)
          process.exit(1)
        }

        if (models.length === 0) {
          spinner.stop("No models found")
          prompts.log.warn("The endpoint returned no models.")
          process.exit(1)
        }

        spinner.stop(`Found ${models.length} model(s)`)

        for (const m of models) {
          const owner = m.owned_by ? ` (${m.owned_by})` : ""
          prompts.log.info(`  ${m.id}${owner}`)
        }

        const scope = (args.scope as "project" | "global") ?? "project"

        const result = await addProvider({
          name,
          baseURL,
          apiKey,
          models,
          scope,
        })

        prompts.log.success(
          `Provider "${result.providerID}" added with ${result.modelCount} model(s) — ${scope} config`,
        )

        if (models.length === 1) {
          prompts.log.info(`Use with: bountyreaper --model ${result.providerID}/${models[0].id}`)
        } else {
          prompts.log.info(`Use with: bountyreaper --model ${result.providerID}/<model-id>`)
        }

        if (!nonInteractive) prompts.outro("Done")
      },
    })
  },
})

export const ProviderListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configured custom providers",

  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const cfg = await Config.get()
        const providers = cfg.provider ?? {}
        const ids = Object.keys(providers)

        if (ids.length === 0) {
          console.log("No custom providers configured.")
          return
        }

        for (const id of ids) {
          const p = providers[id]!
          const found = await locateProvider(id)
          const modelCount = p.models ? Object.keys(p.models).length : 0
          const api = p.api ?? "n/a"
          const scope = found ? ` [${found.scope}]` : ""
          console.log(`  ${UI.Style.TEXT_HIGHLIGHT}${id}${UI.Style.TEXT_NORMAL}  ${p.name ?? id}${scope}`)
          console.log(`    api: ${api}`)
          console.log(`    models: ${modelCount}`)
          if (p.models) {
            for (const mid of Object.keys(p.models)) {
              console.log(`      - ${mid}`)
            }
          }
          console.log()
        }
      },
    })
  },
})

export const ProviderRemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "remove a custom provider or one of its models",

  builder: (yargs: Argv) =>
    yargs
      .positional("id", {
        type: "string",
        describe: "provider ID to remove",
        demandOption: true,
      })
      .option("model", {
        type: "string",
        describe: "remove a single model instead of the whole provider",
      })
      .option("scope", {
        type: "string",
        describe: "config scope to remove from",
        choices: ["project", "global"] as const,
      })
      .option("yes", {
        type: "boolean",
        describe: "skip confirmation",
        default: false,
      }),

  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const id = args.id as string
        const found = await locateProvider(id, args.scope)

        if (!found) {
          prompts.log.error(`Provider "${id}" not found in ${args.scope ?? "project or global"} config.`)
          process.exit(1)
        }

        if (args.model) {
          if (!found.models.includes(args.model)) {
            prompts.log.error(`Provider "${id}" has no model "${args.model}" (${found.models.length} configured).`)
            process.exit(1)
          }
          const dropped = await removeModel(found, id, args.model)
          prompts.log.success(
            dropped
              ? `Removed last model "${args.model}" — provider "${id}" removed from ${found.scope} config.`
              : `Removed model "${args.model}" from provider "${id}" (${found.scope} config).`,
          )
          return
        }

        if (!args.yes) {
          const ok = await prompts.confirm({
            message: `Remove provider "${id}" with ${found.models.length} model(s) from ${found.scope} config?`,
          })
          if (prompts.isCancel(ok) || !ok) throw new UI.CancelledError()
        }

        await removeProvider(found, id)
        prompts.log.success(
          `Provider "${id}" removed from ${found.scope} config (${found.filepath}), credentials deleted.`,
        )
      },
    })
  },
})
