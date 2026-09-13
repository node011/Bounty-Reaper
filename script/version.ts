#!/usr/bin/env bun

import { Script } from "@bountyreper-io/script"
import { $ } from "bun"
import { buildNotes, getLatestRelease } from "./changelog"

const output = [`version=${Script.version}`]

if (!Script.preview) {
  // First release: npm has no dist-tags and no prior GH release exists yet.
  const previous = await getLatestRelease(Script.version).catch((e) => {
    console.log("no previous release found (first release?):", (e as Error).message)
    return undefined
  })
  const notes = previous
    ? await buildNotes(previous, "HEAD")
    : ["## Highlights", "", `First tagged release: v${Script.version}.`, "", "See the commit history for the full set of changes."]
  const body = notes.join("\n") || "No notable changes"
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const file = `${dir}/bountyreper-release-notes.txt`
  await Bun.write(file, body)
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --notes-file ${file}`
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
