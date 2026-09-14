import { Auth } from "../auth"
import { Config } from "../config/config"
import { Global } from "../global"
import { Instance } from "../project/instance"
import path from "path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"

export interface DiscoveredModel {
  id: string
  owned_by?: string
}

function normalizeBaseURL(input: string): string {
  return input
    .replace(/\/+$/, "")
    .replace(/\/(chat\/)?completions$/, "")
    .replace(/\/models$/, "")
}

export async function discoverModels(baseURL: string, apiKey?: string): Promise<DiscoveredModel[]> {
  const base = normalizeBaseURL(baseURL)
  const url = base + "/models"
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)

  const body = (await response.json()) as { data?: { id: string; owned_by?: string }[]; object?: string }
  if (!body.data || !Array.isArray(body.data)) throw new Error("Invalid response: missing data array")

  return body.data.map((m) => ({ id: m.id, owned_by: m.owned_by }))
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export async function addProvider(input: {
  name: string
  baseURL: string
  apiKey?: string
  models: DiscoveredModel[]
  scope: "project" | "global"
}) {
  const providerID = slugify(input.name)

  const models: Record<string, { name: string; tool_call: boolean; limit: { context: number; output: number } }> = {}
  for (const m of input.models) {
    models[m.id] = {
      name: m.id,
      tool_call: true,
      limit: { context: 131072, output: 32768 },
    }
  }

  const config: Config.Info = {
    provider: {
      [providerID]: {
        name: input.name,
        api: normalizeBaseURL(input.baseURL),
        models,
      },
    },
  }

  if (input.scope === "project") {
    await Config.update(config)
  } else {
    await Config.updateGlobal(config)
  }

  if (input.apiKey) {
    await Auth.set(providerID, { type: "api", key: input.apiKey })
  }

  await Instance.dispose()

  return { providerID, modelCount: input.models.length }
}

export interface LocatedProvider {
  scope: "project" | "global"
  filepath: string
  models: string[]
}

function candidates(scope: "project" | "global") {
  if (scope === "project")
    return ["bountyreaper.jsonc", "bountyreaper.json"].map((file) => path.join(Instance.directory, file))
  return ["bountyreaper.jsonc", "bountyreaper.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
}

async function scan(scope: "project" | "global", providerID: string): Promise<LocatedProvider | undefined> {
  for (const filepath of candidates(scope)) {
    const text = await Bun.file(filepath)
      .text()
      .catch(() => undefined)
    if (!text) continue
    const found = (parseJsonc(text) as { provider?: Record<string, { models?: Record<string, unknown> }> }).provider?.[
      providerID
    ]
    if (!found) continue
    return { scope, filepath, models: Object.keys(found.models ?? {}) }
  }
}

export async function locateProvider(providerID: string, scope?: "project" | "global") {
  if (scope) return scan(scope, providerID)
  return (await scan("project", providerID)) ?? (await scan("global", providerID))
}

async function cut(filepath: string, keys: string[]) {
  const text = await Bun.file(filepath).text()
  await Bun.write(
    filepath,
    applyEdits(text, modify(text, keys, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
  )
  await Instance.dispose()
}

export async function removeProvider(found: LocatedProvider, providerID: string) {
  await cut(found.filepath, ["provider", providerID])
  await Auth.remove(providerID)
}

export async function removeModel(found: LocatedProvider, providerID: string, model: string) {
  if (found.models.length === 1) {
    await removeProvider(found, providerID)
    return true
  }
  await cut(found.filepath, ["provider", providerID, "models", model])
  return false
}
